#!/usr/bin/env python3

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import sqlite3
import ssl
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAX_BODY_BYTES = 1_048_576
MAX_CLOCK_SKEW_MS = 300_000
NONCE_RETENTION_MS = 600_000


def payload_key(secret: bytes, device_id: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=device_id.encode("utf-8"),
        info=b"caconnection/payload-encryption/v1",
    ).derive(secret)


def encryption_aad(envelope: dict[str, Any], device_id: str) -> bytes:
    return "\n".join(
        (
            "2",
            str(envelope["deliveryId"]),
            str(envelope["sourceEventId"]),
            str(envelope["eventType"]),
            str(envelope["createdAt"]),
            "" if envelope.get("subscriptionId") is None else str(envelope["subscriptionId"]),
            "" if envelope.get("slotIndex") is None else str(envelope["slotIndex"]),
            device_id,
        )
    ).encode("utf-8")


def encrypt_payload(
    envelope: dict[str, Any], device_id: str, secret: bytes
) -> dict[str, Any]:
    if envelope.get("schemaVersion") == 2:
        return envelope
    nonce = __import__("os").urandom(12)
    outer = {key: value for key, value in envelope.items() if key != "payload"}
    outer["schemaVersion"] = 2
    plaintext = json.dumps(
        envelope["payload"], separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    ciphertext = AESGCM(payload_key(secret, device_id)).encrypt(
        nonce, plaintext, encryption_aad(outer, device_id)
    )
    outer["payload"] = {
        "algorithm": "AES-256-GCM",
        "nonceBase64": base64.b64encode(nonce).decode("ascii"),
        "ciphertextBase64": base64.b64encode(ciphertext).decode("ascii"),
    }
    return outer


def decrypt_payload(
    envelope: dict[str, Any], device_id: str, secret: bytes
) -> dict[str, Any]:
    if envelope.get("schemaVersion") == 1:
        return envelope
    try:
        encrypted = envelope["payload"]
        nonce = base64.b64decode(encrypted["nonceBase64"], validate=True)
        if len(nonce) != 12:
            raise ValueError("invalid AES-GCM nonce length")
        ciphertext = base64.b64decode(
            encrypted["ciphertextBase64"], validate=True
        )
        plaintext = AESGCM(payload_key(secret, device_id)).decrypt(
            nonce, ciphertext, encryption_aad(envelope, device_id)
        )
        payload = json.loads(plaintext)
        if not isinstance(payload, dict):
            raise ValueError("decrypted payload must be a JSON object")
    except (
        InvalidTag,
        binascii.Error,
        KeyError,
        TypeError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as error:
        raise ValueError("invalid encrypted payload") from error
    result = dict(envelope)
    result["payload"] = payload
    return result


def canonical_request(
    timestamp_ms: int,
    nonce: str,
    device_id: str,
    idempotency_key: str,
    body: bytes,
) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join(
        (str(timestamp_ms), nonce, device_id, idempotency_key, body_hash)
    ).encode("utf-8")


def expected_signature(
    secret: bytes,
    timestamp_ms: int,
    nonce: str,
    device_id: str,
    idempotency_key: str,
    body: bytes,
) -> str:
    digest = hmac.new(
        secret,
        canonical_request(
            timestamp_ms, nonce, device_id, idempotency_key, body
        ),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


class GatewayStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    delivery_id TEXT NOT NULL,
                    source_event_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    received_at INTEGER NOT NULL,
                    subscription_id INTEGER,
                    slot_index INTEGER,
                    envelope_json TEXT NOT NULL,
                    UNIQUE(device_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS request_nonces (
                    device_id TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    seen_at INTEGER NOT NULL,
                    PRIMARY KEY(device_id, nonce)
                );
                """
            )

    def accept(
        self,
        device_id: str,
        idempotency_key: str,
        nonce: str,
        envelope: dict[str, Any],
        now_ms: int,
    ) -> bool:
        with self._lock, self._connect() as db:
            db.execute(
                "DELETE FROM request_nonces WHERE seen_at < ?",
                (now_ms - NONCE_RETENTION_MS,),
            )
            try:
                db.execute(
                    "INSERT INTO request_nonces(device_id, nonce, seen_at) "
                    "VALUES (?, ?, ?)",
                    (device_id, nonce, now_ms),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("replayed nonce") from error

            cursor = db.execute(
                """
                INSERT OR IGNORE INTO events(
                    device_id, idempotency_key, delivery_id,
                    source_event_id, event_type, created_at, received_at,
                    subscription_id, slot_index, envelope_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    idempotency_key,
                    envelope["deliveryId"],
                    envelope["sourceEventId"],
                    envelope["eventType"],
                    int(envelope["createdAt"]),
                    now_ms,
                    envelope.get("subscriptionId"),
                    envelope.get("slotIndex"),
                    json.dumps(envelope, separators=(",", ":"), ensure_ascii=False),
                ),
            )
            return cursor.rowcount == 1

    def latest(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT id, device_id, idempotency_key, event_type,
                       created_at, received_at, subscription_id, slot_index,
                       envelope_json
                FROM events ORDER BY id DESC LIMIT ?
                """,
                (min(max(limit, 1), 500),),
            ).fetchall()
        return [
            {
                **{key: row[key] for key in row.keys() if key != "envelope_json"},
                "envelope": json.loads(row["envelope_json"]),
            }
            for row in rows
        ]

    def migrate_legacy_payloads(self, devices: dict[str, bytes]) -> int:
        migrated = 0
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT id, device_id, envelope_json FROM events"
            ).fetchall()
            for row in rows:
                envelope = json.loads(row["envelope_json"])
                if envelope.get("schemaVersion") != 1:
                    continue
                secret = devices.get(row["device_id"])
                if secret is None:
                    continue
                encrypted = encrypt_payload(envelope, row["device_id"], secret)
                db.execute(
                    "UPDATE events SET envelope_json = ? WHERE id = ?",
                    (
                        json.dumps(
                            encrypted,
                            separators=(",", ":"),
                            ensure_ascii=False,
                        ),
                        row["id"],
                    ),
                )
                migrated += 1
        if migrated:
            with self._connect() as db:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")
        return migrated

    def clear(self) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM events")
            db.execute("DELETE FROM request_nonces")


def validate_envelope(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("body must be a JSON object")
    required = {
        "schemaVersion",
        "deliveryId",
        "sourceEventId",
        "eventType",
        "createdAt",
        "payload",
    }
    if not required.issubset(value):
        raise ValueError("missing envelope fields")
    if value["schemaVersion"] not in (1, 2):
        raise ValueError("unsupported schemaVersion")
    if not isinstance(value["payload"], dict):
        raise ValueError("payload must be a JSON object")
    if value["schemaVersion"] == 2:
        payload = value["payload"]
        if payload.get("algorithm") != "AES-256-GCM":
            raise ValueError("unsupported payload encryption")
        if not payload.get("nonceBase64") or not payload.get("ciphertextBase64"):
            raise ValueError("missing encrypted payload fields")
    return value


VIEWER_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personal Communication Gateway</title>
<style>
body{font:15px system-ui;margin:0;background:#f5f7fa;color:#172033}
header{padding:18px 24px;background:#172033;color:white}
main{max-width:1100px;margin:auto;padding:20px}
button{padding:8px 12px;margin-right:8px}
.event{background:white;border:1px solid #dce2ea;border-radius:10px;padding:14px;margin:12px 0}
.meta{color:#5d6878;font-size:13px}.sensitive{filter:blur(7px);user-select:none}
pre{white-space:pre-wrap;word-break:break-word;background:#f0f3f7;padding:10px}
</style></head>
<body><header><b>Personal Communication Gateway — Local Receiver</b></header>
<main><p>This viewer is available only from this Mac. Sensitive values are hidden by default.</p>
<button onclick="loadEvents()">Refresh</button>
<button onclick="clearEvents()">Clear local receiver data</button>
<div id="events"></div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function summary(e){
 const p=e.envelope.payload||{}; let sensitive='';
 if(e.event_type==='INCOMING_SMS') sensitive=p.body||'';
 if(e.event_type==='CALL_IDENTITY') sensitive=p.callerAddress||'withheld/unknown';
 return `<div class="event"><b>${esc(e.event_type)}</b>
 <div class="meta">${new Date(e.received_at).toLocaleString()} · device ${esc(e.device_id)}
 · SIM${e.slot_index==null?'?':e.slot_index+1} · subId ${esc(e.subscription_id??'?')}</div>
 ${sensitive?`<p>Protected value: <span class="sensitive">${esc(sensitive)}</span>
 <button onclick="this.previousElementSibling.classList.toggle('sensitive')">Reveal/hide</button></p>`:''}
 <details><summary>Envelope</summary><pre>${esc(JSON.stringify(e.envelope,null,2))}</pre></details></div>`;
}
async function loadEvents(){const r=await fetch('/api/events');const d=await r.json();
 document.querySelector('#events').innerHTML=d.events.map(summary).join('')||'<p>No events.</p>'}
async function clearEvents(){if(!confirm('Delete all local receiver events?'))return;
 await fetch('/api/clear',{method:'POST',headers:{'X-Confirm-Clear':'yes'}});loadEvents()}
loadEvents();
</script></body></html>"""


def is_loopback(address: str) -> bool:
    return address in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "GatewayReceiver/1"

    @property
    def app(self) -> "GatewayHttpServer":
        return self.server  # type: ignore[return-value]

    def log_message(self, format_string: str, *args: Any) -> None:
        # Never log headers, request bodies, caller addresses, or SMS content.
        print(
            f"{self.client_address[0]} "
            f"{format_string % args}"
        )

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if not is_loopback(self.client_address[0]):
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "local viewer only"})
            return
        if path == "/":
            body = VIEWER_HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/events":
            events = self.app.store.latest()
            for event in events:
                secret = self.app.devices[event["device_id"]]
                event["envelope"] = decrypt_payload(
                    event["envelope"], event["device_id"], secret
                )
            self.send_json(
                HTTPStatus.OK, {"events": events}
            )
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/clear":
            if not is_loopback(self.client_address[0]):
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "local viewer only"})
            elif self.headers.get("X-Confirm-Clear") != "yes":
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "confirmation required"})
            else:
                self.app.store.clear()
                self.send_json(HTTPStatus.OK, {"cleared": True})
            return
        if path != "/v1/events":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self.app.accept_ingestion:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(
                HTTPStatus.BAD_REQUEST, {"error": "invalid content length"}
            )
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid body size"})
            return
        body = self.rfile.read(length)
        device_id = self.headers.get("X-Gateway-Device", "")
        nonce = self.headers.get("X-Gateway-Nonce", "")
        idempotency_key = self.headers.get("Idempotency-Key", "")
        signature = self.headers.get("X-Gateway-Signature", "")
        try:
            timestamp_ms = int(self.headers.get("X-Gateway-Timestamp", ""))
        except ValueError:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid timestamp"})
            return

        secret = self.app.devices.get(device_id)
        now_ms = int(time.time() * 1000)
        if (
            secret is None
            or not nonce
            or not idempotency_key
            or abs(now_ms - timestamp_ms) > MAX_CLOCK_SKEW_MS
        ):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "authentication failed"})
            return
        expected = expected_signature(
            secret, timestamp_ms, nonce, device_id, idempotency_key, body
        )
        if not hmac.compare_digest(expected, signature):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "authentication failed"})
            return

        try:
            envelope = validate_envelope(json.loads(body))
            if envelope["schemaVersion"] != 2:
                raise ValueError("encrypted schemaVersion 2 required")
            decrypt_payload(envelope, device_id, secret)
            inserted = self.app.store.accept(
                device_id, idempotency_key, nonce, envelope, now_ms
            )
        except (ValueError, json.JSONDecodeError) as error:
            status = (
                HTTPStatus.CONFLICT
                if str(error) == "replayed nonce"
                else HTTPStatus.BAD_REQUEST
            )
            self.send_json(status, {"error": str(error)})
            return
        self.send_json(
            HTTPStatus.CREATED if inserted else HTTPStatus.OK,
            {"accepted": True, "duplicate": not inserted},
        )


class GatewayHttpServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        devices: dict[str, bytes],
        store: GatewayStore,
        accept_ingestion: bool = True,
    ):
        super().__init__(address, GatewayHandler)
        self.devices = devices
        self.store = store
        self.accept_ingestion = accept_ingestion


def load_devices(path: Path) -> dict[str, bytes]:
    data = json.loads(path.read_text(encoding="utf-8"))
    result = {}
    for device_id, value in data.get("devices", {}).items():
        secret = base64.b64decode(value["secret_base64"], validate=True)
        if len(secret) < 32:
            raise ValueError(f"Secret for {device_id} is shorter than 32 bytes")
        result[device_id] = secret
    if not result:
        raise ValueError("No devices configured")
    return result


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--viewer-port", type=int, default=8788)
    parser.add_argument("--config", type=Path, default=root / "config.json")
    parser.add_argument("--database", type=Path, default=root / "data/gateway.db")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    devices = load_devices(args.config)
    store = GatewayStore(args.database)
    migrated = store.migrate_legacy_payloads(devices)
    server = GatewayHttpServer(
        (args.host, args.port),
        devices,
        store,
    )
    tls = config["tls"]
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(tls["certificate"], tls["private_key"])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    viewer = GatewayHttpServer(
        ("127.0.0.1", args.viewer_port),
        devices,
        store,
        accept_ingestion=False,
    )
    threading.Thread(target=viewer.serve_forever, daemon=True).start()
    print(f"HTTPS gateway receiver listening on {args.host}:{args.port}")
    print("Viewer: http://127.0.0.1:%d/" % args.viewer_port)
    if migrated:
        print(f"Migrated {migrated} legacy payload(s) to encrypted storage")
    server.serve_forever()


if __name__ == "__main__":
    main()
