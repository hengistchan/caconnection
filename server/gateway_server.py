#!/usr/bin/env python3

import argparse
import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import sqlite3
import ssl
import threading
import time
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAX_BODY_BYTES = 1_048_576
MAX_CLOCK_SKEW_MS = 300_000
NONCE_RETENTION_MS = 600_000
SERVICE_VERSION = "0.2.0"
DEFAULT_RETENTION_DAYS = 30
DEFAULT_OTP_MAX_AGE_SECONDS = 600
DEFAULT_INGEST_REQUESTS_PER_MINUTE = 120
DEFAULT_DEVICE_REQUESTS_PER_MINUTE = 120
DEFAULT_API_AUTH_REQUESTS_PER_MINUTE = 120
DEFAULT_API_REQUESTS_PER_MINUTE = 60
DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE = 20
DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE = 20
DEFAULT_MAX_CONCURRENT_REQUESTS = 32
MIN_PAIRING_EXPIRES_SECONDS = 60
MAX_PAIRING_EXPIRES_SECONDS = 600
MAX_RATE_LIMIT_IDENTITIES = 10_000
ALLOWED_EVENT_TYPES = {
    "INCOMING_SMS",
    "NOTIFICATION",
    "CALL_STATE",
    "CALL_IDENTITY",
    "LOCAL_SELF_TEST",
}
OTP_PATTERN = re.compile(r"(?<!\d)(\d{4,8})(?!\d)")
OTP_CONTEXT_PATTERN = re.compile(
    r"验证码|校验码|动态码|认证码|口令|otp|verification|verify|code|passcode",
    re.IGNORECASE,
)
OTP_CONTEXT_BOUNDARIES = ".。!！?？;；\n"


def otp_local_context(body: str, start: int, end: int) -> str:
    left = max(body.rfind(boundary, 0, start) for boundary in OTP_CONTEXT_BOUNDARIES)
    right_candidates = [
        position
        for boundary in OTP_CONTEXT_BOUNDARIES
        if (position := body.find(boundary, end)) >= 0
    ]
    right = min(right_candidates) if right_candidates else len(body)
    return body[left + 1:right]


def extract_otp_candidates(body: str) -> list[str]:
    """Return likely numeric OTP values without persisting another plaintext copy."""
    ranked = []
    seen = set()
    for match in OTP_PATTERN.finditer(body or ""):
        value = match.group(1)
        if value in seen:
            continue
        seen.add(value)
        context = otp_local_context(body, match.start(), match.end())
        contextual = bool(OTP_CONTEXT_PATTERN.search(context))
        preferred_length = len(value) in (6, 4)
        ranked.append((not contextual, not preferred_length, match.start(), value))
    ranked.sort()
    return [value for _, _, _, value in ranked]


def integer_setting(
    settings: dict[str, Any],
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = settings.get(name, default)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not minimum <= value <= maximum
    ):
        raise ValueError(
            f"{name} must be an integer between {minimum} and {maximum}"
        )
    return value


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[tuple[str, str], deque[int]] = defaultdict(deque)
        self._last_cleanup_ms = 0

    def allow(
        self,
        bucket: str,
        key: str,
        limit: int,
        now_ms: int,
    ) -> tuple[bool, int]:
        if limit <= 0:
            return True, 0
        cutoff = now_ms - 60_000
        identity = (bucket, key)
        with self._lock:
            if now_ms - self._last_cleanup_ms >= 60_000:
                for existing_identity, requests in list(self._requests.items()):
                    while requests and requests[0] <= cutoff:
                        requests.popleft()
                    if not requests:
                        del self._requests[existing_identity]
                self._last_cleanup_ms = now_ms
            if (
                identity not in self._requests
                and len(self._requests) >= MAX_RATE_LIMIT_IDENTITIES
            ):
                return False, 60_000
            requests = self._requests[identity]
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if len(requests) >= limit:
                retry_after_ms = max(1, 60_000 - (now_ms - requests[0]))
                return False, retry_after_ms
            requests.append(now_ms)
            return True, 0


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
                CREATE TABLE IF NOT EXISTS otp_claims (
                    event_id INTEGER PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    claimed_at INTEGER NOT NULL,
                    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS pairing_sessions (
                    token_sha256 TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    consumed_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS index_events_type_received
                    ON events(event_type, received_at DESC);
                CREATE INDEX IF NOT EXISTS index_pairing_sessions_expiry
                    ON pairing_sessions(expires_at);
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    secret_base64 TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS gateway_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )

    def create_pairing(
        self,
        token: str,
        device_id: str,
        now_ms: int,
        expires_in_seconds: int,
    ) -> int:
        token_digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires_at = now_ms + expires_in_seconds * 1000
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "DELETE FROM pairing_sessions WHERE expires_at < ?",
                (now_ms - 86_400_000,),
            )
            db.execute(
                """
                UPDATE pairing_sessions
                SET consumed_at = ?
                WHERE device_id = ?
                  AND consumed_at IS NULL
                  AND expires_at >= ?
                """,
                (now_ms, device_id, now_ms),
            )
            db.execute(
                """
                INSERT INTO pairing_sessions(
                    token_sha256, device_id, created_at, expires_at, consumed_at
                ) VALUES (?, ?, ?, ?, NULL)
                """,
                (token_digest, device_id, now_ms, expires_at),
            )
        return expires_at

    def claim_pairing(self, token: str, now_ms: int) -> Optional[str]:
        token_digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """
                SELECT device_id
                FROM pairing_sessions
                WHERE token_sha256 = ?
                  AND consumed_at IS NULL
                  AND expires_at >= ?
                """,
                (token_digest, now_ms),
            ).fetchone()
            if row is None:
                return None
            cursor = db.execute(
                """
                UPDATE pairing_sessions
                SET consumed_at = ?
                WHERE token_sha256 = ? AND consumed_at IS NULL
                """,
                (now_ms, token_digest),
            )
            if cursor.rowcount != 1:
                return None
            return str(row["device_id"])

    # ── Device CRUD ──────────────────────────────────────────────

    def get_devices(self) -> list[dict[str, Any]]:
        """Return all devices from the database."""
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT device_id, secret_base64, description,
                       created_at, last_seen_at
                FROM devices
                ORDER BY device_id
                """
            ).fetchall()
        return [
            {
                "deviceId": row["device_id"],
                "description": row["description"] or "",
                "createdAt": row["created_at"],
                "lastSeenAt": row["last_seen_at"],
            }
            for row in rows
        ]

    def get_device(self, device_id: str) -> Optional[dict[str, Any]]:
        """Return a single device by ID."""
        with self._connect() as db:
            row = db.execute(
                """
                SELECT device_id, secret_base64, description,
                       created_at, last_seen_at
                FROM devices
                WHERE device_id = ?
                """,
                (device_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "deviceId": row["device_id"],
            "description": row["description"] or "",
            "createdAt": row["created_at"],
            "lastSeenAt": row["last_seen_at"],
        }

    def add_device(
        self,
        device_id: str,
        secret_base64: str,
        description: str,
        now_ms: int,
    ) -> dict[str, Any]:
        """Add a new device. Raises ValueError if already exists."""
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id):
            raise ValueError("Invalid device ID format")
        try:
            secret_bytes = base64.b64decode(secret_base64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValueError("Invalid base64 secret") from e
        if len(secret_bytes) < 32:
            raise ValueError("Secret must be at least 32 bytes")
        with self._lock, self._connect() as db:
            try:
                db.execute(
                    """
                    INSERT INTO devices(device_id, secret_base64, description, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (device_id, secret_base64, description, now_ms),
                )
            except sqlite3.IntegrityError as e:
                raise ValueError(f"Device '{device_id}' already exists") from e
        return {
            "deviceId": device_id,
            "description": description,
            "createdAt": now_ms,
            "lastSeenAt": None,
        }

    def update_device(
        self,
        device_id: str,
        description: Optional[str] = None,
        secret_base64: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Update device description and/or secret.

        Existing event payloads are encrypted with the device secret. Secret
        rotation therefore re-encrypts those payloads in the same transaction
        before storing the new secret, so historical messages remain readable.
        """
        new_secret: Optional[bytes] = None
        if secret_base64 is not None:
            try:
                new_secret = base64.b64decode(secret_base64, validate=True)
            except (binascii.Error, ValueError) as e:
                raise ValueError("Invalid base64 secret") from e
            if len(new_secret) < 32:
                raise ValueError("Secret must be at least 32 bytes")
        with self._lock, self._connect() as db:
            existing = db.execute(
                "SELECT secret_base64 FROM devices WHERE device_id = ?",
                (device_id,),
            ).fetchone()
            if existing is None:
                return None
            if description is not None:
                db.execute(
                    "UPDATE devices SET description = ? WHERE device_id = ?",
                    (description, device_id),
                )
            if secret_base64 is not None and new_secret is not None:
                try:
                    old_secret = base64.b64decode(
                        existing["secret_base64"], validate=True
                    )
                except (binascii.Error, ValueError) as error:
                    raise ValueError("Stored device secret is invalid") from error
                if old_secret != new_secret:
                    event_rows = db.execute(
                        """
                        SELECT id, envelope_json
                        FROM events
                        WHERE device_id = ?
                        """,
                        (device_id,),
                    ).fetchall()
                    for event_row in event_rows:
                        envelope = decrypt_payload(
                            json.loads(event_row["envelope_json"]),
                            device_id,
                            old_secret,
                        )
                        envelope["schemaVersion"] = 1
                        reencrypted = encrypt_payload(
                            envelope,
                            device_id,
                            new_secret,
                        )
                        db.execute(
                            "UPDATE events SET envelope_json = ? WHERE id = ?",
                            (
                                json.dumps(
                                    reencrypted,
                                    separators=(",", ":"),
                                    ensure_ascii=False,
                                ),
                                event_row["id"],
                            ),
                        )
                db.execute(
                    "UPDATE devices SET secret_base64 = ? WHERE device_id = ?",
                    (secret_base64, device_id),
                )
            row = db.execute(
                "SELECT * FROM devices WHERE device_id = ?",
                (device_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "deviceId": row["device_id"],
            "description": row["description"] or "",
            "createdAt": row["created_at"],
            "lastSeenAt": row["last_seen_at"],
        }

    def delete_device(self, device_id: str) -> bool:
        """Delete a device. Returns True if deleted."""
        with self._lock, self._connect() as db:
            cursor = db.execute(
                "DELETE FROM devices WHERE device_id = ?",
                (device_id,),
            )
            return cursor.rowcount == 1

    def touch_device(self, device_id: str, now_ms: int) -> None:
        """Update device last_seen_at timestamp."""
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE devices SET last_seen_at = ? WHERE device_id = ?",
                (now_ms, device_id),
            )

    def load_devices(self) -> dict[str, bytes]:
        """Load all devices from database, return dict of device_id -> secret_bytes."""
        with self._connect() as db:
            rows = db.execute(
                "SELECT device_id, secret_base64 FROM devices"
            ).fetchall()
        result = {}
        for row in rows:
            try:
                secret = base64.b64decode(row["secret_base64"], validate=True)
                if len(secret) >= 32:
                    result[row["device_id"]] = secret
            except (binascii.Error, ValueError):
                continue
        return result

    def migrate_devices_from_config(self, config_devices: dict[str, bytes]) -> int:
        """Migrate config devices once, then keep the database authoritative."""
        marker_key = "config_devices_migrated_v1"
        migrated = 0
        now_ms = int(time.time() * 1000)
        with self._lock, self._connect() as db:
            marker = db.execute(
                "SELECT value FROM gateway_metadata WHERE key = ?",
                (marker_key,),
            ).fetchone()
            if marker is not None:
                return 0
            for device_id, secret_bytes in config_devices.items():
                secret_base64 = base64.b64encode(secret_bytes).decode("ascii")
                existing = db.execute(
                    "SELECT 1 FROM devices WHERE device_id = ?",
                    (device_id,),
                ).fetchone()
                if existing is None:
                    db.execute(
                        """
                        INSERT INTO devices(device_id, secret_base64, description, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (device_id, secret_base64, "Migrated from config", now_ms),
                    )
                    migrated += 1
            db.execute(
                """
                INSERT INTO gateway_metadata(key, value)
                VALUES (?, ?)
                """,
                (marker_key, str(now_ms)),
            )
        return migrated

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

    def check_health(self) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1").fetchone()[0] == 1

    def prune(self, retention_days: int, now_ms: int) -> int:
        if retention_days <= 0:
            return 0
        cutoff = now_ms - retention_days * 86_400_000
        with self._lock, self._connect() as db:
            db.execute(
                "DELETE FROM otp_claims WHERE event_id IN "
                "(SELECT id FROM events WHERE received_at < ?)",
                (cutoff,),
            )
            cursor = db.execute(
                "DELETE FROM events WHERE received_at < ?",
                (cutoff,),
            )
            return cursor.rowcount

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

    def incoming_messages(
        self,
        devices: dict[str, bytes],
        limit: int,
        after_id: Optional[int] = None,
        before_id: Optional[int] = None,
        slot_index: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        clauses = ["event_type = 'INCOMING_SMS'"]
        parameters: list[Any] = []
        if after_id is not None:
            clauses.append("id > ?")
            parameters.append(after_id)
        if before_id is not None:
            clauses.append("id < ?")
            parameters.append(before_id)
        if slot_index is not None:
            clauses.append("slot_index = ?")
            parameters.append(slot_index)
        parameters.append(min(max(limit, 1), 100))
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT id, device_id, created_at, received_at,
                       subscription_id, slot_index, envelope_json
                FROM events
                WHERE %s
                ORDER BY id DESC
                LIMIT ?
                """ % " AND ".join(clauses),
                parameters,
            ).fetchall()
        messages = []
        for row in rows:
            secret = devices.get(row["device_id"])
            if secret is None:
                continue
            envelope = decrypt_payload(
                json.loads(row["envelope_json"]), row["device_id"], secret
            )
            payload = envelope["payload"]
            body = payload.get("body")
            messages.append(
                {
                    "id": row["id"],
                    "deviceId": row["device_id"],
                    "createdAt": row["created_at"],
                    "receivedAt": row["received_at"],
                    "subscriptionId": row["subscription_id"],
                    "slotIndex": row["slot_index"],
                    "sender": payload.get("originatingAddress"),
                    "body": body,
                    "partCount": payload.get("partCount"),
                    "resolutionMethod": payload.get("resolutionMethod"),
                    "resolutionConfidence": payload.get(
                        "resolutionConfidence"
                    ),
                    "otpCandidates": extract_otp_candidates(
                        body if isinstance(body, str) else ""
                    ),
                }
            )
        return messages

    def notifications(
        self,
        devices: dict[str, bytes],
        limit: int,
        after_id: Optional[int] = None,
        before_id: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        clauses = ["event_type = 'NOTIFICATION'"]
        parameters: list[Any] = []
        if after_id is not None:
            clauses.append("id > ?")
            parameters.append(after_id)
        if before_id is not None:
            clauses.append("id < ?")
            parameters.append(before_id)
        parameters.append(min(max(limit, 1), 100))
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT id, device_id, created_at, received_at, envelope_json
                FROM events
                WHERE %s
                ORDER BY id DESC
                LIMIT ?
                """ % " AND ".join(clauses),
                parameters,
            ).fetchall()
        notifications = []
        for row in rows:
            secret = devices.get(row["device_id"])
            if secret is None:
                continue
            envelope = decrypt_payload(
                json.loads(row["envelope_json"]), row["device_id"], secret
            )
            payload = envelope["payload"]

            def optional_string(name: str) -> Optional[str]:
                value = payload.get(name)
                return value if isinstance(value, str) else None

            notification_id = payload.get("notificationId")
            posted_at = payload.get("postedAt")
            observed_at = payload.get("observedAt")
            notifications.append(
                {
                    "id": row["id"],
                    "deviceId": row["device_id"],
                    "createdAt": row["created_at"],
                    "receivedAt": row["received_at"],
                    "eventType": optional_string("eventType"),
                    "sourcePackage": optional_string("sourcePackage"),
                    "notificationId": (
                        notification_id
                        if isinstance(notification_id, int)
                        and not isinstance(notification_id, bool)
                        else None
                    ),
                    "postedAt": (
                        posted_at
                        if isinstance(posted_at, int)
                        and not isinstance(posted_at, bool)
                        else None
                    ),
                    "observedAt": (
                        observed_at
                        if isinstance(observed_at, int)
                        and not isinstance(observed_at, bool)
                        else None
                    ),
                    "channelId": optional_string("channelId"),
                    "category": optional_string("category"),
                    "title": optional_string("title"),
                    "body": optional_string("body"),
                }
            )
        return notifications

    def claim_latest_otp(
        self,
        devices: dict[str, bytes],
        client_id: str,
        now_ms: int,
        max_age_seconds: int,
        slot_index: Optional[int] = None,
        event_id: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        cutoff = now_ms - max_age_seconds * 1000
        clauses = [
            "e.event_type = 'INCOMING_SMS'",
            "e.received_at >= ?",
            "c.event_id IS NULL",
        ]
        parameters: list[Any] = [cutoff]
        if slot_index is not None:
            clauses.append("e.slot_index = ?")
            parameters.append(slot_index)
        if event_id is not None:
            clauses.append("e.id = ?")
            parameters.append(event_id)
        with self._lock, self._connect() as db:
            rows = db.execute(
                """
                SELECT e.id, e.device_id, e.received_at,
                       e.subscription_id, e.slot_index, e.envelope_json
                FROM events e
                LEFT JOIN otp_claims c ON c.event_id = e.id
                WHERE %s
                ORDER BY e.received_at DESC
                """ % " AND ".join(clauses),
                parameters,
            ).fetchall()
            for row in rows:
                secret = devices.get(row["device_id"])
                if secret is None:
                    continue
                envelope = decrypt_payload(
                    json.loads(row["envelope_json"]),
                    row["device_id"],
                    secret,
                )
                body = envelope["payload"].get("body")
                candidates = extract_otp_candidates(
                    body if isinstance(body, str) else ""
                )
                if not candidates:
                    continue
                cursor = db.execute(
                    """
                    INSERT OR IGNORE INTO otp_claims(
                        event_id, client_id, claimed_at
                    ) VALUES (?, ?, ?)
                    """,
                    (row["id"], client_id, now_ms),
                )
                if cursor.rowcount != 1:
                    continue
                return {
                    "eventId": row["id"],
                    "deviceId": row["device_id"],
                    "receivedAt": row["received_at"],
                    "subscriptionId": row["subscription_id"],
                    "slotIndex": row["slot_index"],
                    "code": candidates[0],
                    "expiresAt": row["received_at"] + max_age_seconds * 1000,
                }
        return None

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
            db.execute("DELETE FROM otp_claims")
            db.execute("DELETE FROM events")
            db.execute("DELETE FROM request_nonces")
            db.execute("DELETE FROM pairing_sessions")


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
    for field in ("deliveryId", "sourceEventId"):
        if not isinstance(value[field], str) or not 1 <= len(value[field]) <= 128:
            raise ValueError(f"invalid {field}")
    if value["eventType"] not in ALLOWED_EVENT_TYPES:
        raise ValueError("unsupported eventType")
    if (
        not isinstance(value["createdAt"], int)
        or isinstance(value["createdAt"], bool)
        or value["createdAt"] < 0
    ):
        raise ValueError("invalid createdAt")
    for field in ("subscriptionId", "slotIndex"):
        field_value = value.get(field)
        if field_value is not None and (
            not isinstance(field_value, int) or isinstance(field_value, bool)
        ):
            raise ValueError(f"invalid {field}")
    if value.get("slotIndex") is not None and not 0 <= value["slotIndex"] <= 3:
        raise ValueError("invalid slotIndex")
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
    server_version = "GatewayReceiver/2"

    @property
    def app(self) -> "GatewayHttpServer":
        return self.server  # type: ignore[return-value]

    def log_message(self, format_string: str, *args: Any) -> None:
        # Never log headers, request bodies, caller addresses, or SMS content.
        print(
            f"{self.client_ip()} "
            f"{format_string % args}"
        )

    def send_json(
        self,
        status: int,
        value: dict[str, Any],
        extra_headers: Optional[dict[str, str]] = None,
    ) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self) -> str:
        if self.app.trust_proxy_headers:
            forwarded = self.headers.get("X-Forwarded-For", "")
            first = forwarded.split(",", 1)[0].strip()
            if first:
                try:
                    return str(ipaddress.ip_address(first))
                except ValueError:
                    pass
        return self.client_address[0]

    def rate_limit(self, bucket: str, key: str, limit: int) -> bool:
        allowed, retry_after_ms = self.app.rate_limiter.allow(
            bucket,
            key,
            limit,
            int(time.time() * 1000),
        )
        if allowed:
            return True
        self.send_json(
            HTTPStatus.TOO_MANY_REQUESTS,
            {"error": "rate limit exceeded"},
            {"Retry-After": str(max(1, (retry_after_ms + 999) // 1000))},
        )
        return False

    def authorize_api(self, required_scope: str) -> Optional[str]:
        if not self.rate_limit(
            "api-auth",
            self.client_ip(),
            self.app.api_auth_requests_per_minute,
        ):
            return None
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            self.send_json(
                HTTPStatus.UNAUTHORIZED, {"error": "authentication required"}
            )
            return None
        token = authorization.removeprefix("Bearer ").strip()
        if not token or len(token) > 512:
            self.send_json(
                HTTPStatus.UNAUTHORIZED, {"error": "authentication failed"}
            )
            return None
        token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        matched_client = None
        matched_scopes: set[str] = set()
        for client_id, client in self.app.api_clients.items():
            if hmac.compare_digest(client["token_sha256"], token_digest):
                matched_client = client_id
                matched_scopes = set(client["scopes"])
                break
        if matched_client is None:
            self.send_json(
                HTTPStatus.UNAUTHORIZED, {"error": "authentication failed"}
            )
            return None
        if required_scope not in matched_scopes and "*" not in matched_scopes:
            self.send_json(
                HTTPStatus.FORBIDDEN, {"error": "insufficient scope"}
            )
            return None
        if not self.rate_limit(
            "api",
            matched_client,
            self.app.api_requests_per_minute,
        ):
            return None
        return matched_client

    def read_json_body(self, maximum_bytes: int = 16_384) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("application/json is required")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("invalid content length") from error
        if length <= 0 or length > maximum_bytes:
            raise ValueError("invalid body size")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("body must be a JSON object")
        return value

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if path == "/version":
            self.send_json(
                HTTPStatus.OK,
                {
                    "service": "caconnection-gateway",
                    "version": SERVICE_VERSION,
                    "apiVersion": 1,
                    "protocolSchemaVersion": 2,
                },
            )
            return
        if path == "/ready":
            ready = (
                self.app.store.check_health()
                and bool(self.app.devices)
                and bool(self.app.api_clients)
            )
            self.send_json(
                HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
                {"status": "ready" if ready else "not_ready"},
            )
            return
        if path == "/v1/messages":
            if self.authorize_api("messages:read") is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {"limit", "afterId", "beforeId", "slotIndex"}
                    or any(len(values) != 1 for values in query.values())
                ):
                    raise ValueError("invalid query")
                limit = int(query.get("limit", ["50"])[0])
                if not 1 <= limit <= 100:
                    raise ValueError("invalid limit")
                after_id_raw = query.get("afterId", [None])[0]
                after_id = (
                    int(after_id_raw) if after_id_raw is not None else None
                )
                if after_id is not None and after_id < 0:
                    raise ValueError("invalid afterId")
                before_id_raw = query.get("beforeId", [None])[0]
                before_id = (
                    int(before_id_raw) if before_id_raw is not None else None
                )
                if before_id is not None and before_id < 1:
                    raise ValueError("invalid beforeId")
                if after_id is not None and before_id is not None:
                    raise ValueError("conflicting cursors")
                slot_raw = query.get("slotIndex", [None])[0]
                slot_index = int(slot_raw) if slot_raw is not None else None
                if slot_index is not None and slot_index not in (0, 1):
                    raise ValueError("invalid slotIndex")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid query"}
                )
                return
            messages = self.app.store.incoming_messages(
                self.app.devices,
                limit,
                after_id=after_id,
                before_id=before_id,
                slot_index=slot_index,
            )
            self.send_json(HTTPStatus.OK, {"messages": messages})
            return
        if path == "/v1/notifications":
            if self.authorize_api("messages:read") is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {"limit", "afterId", "beforeId"}
                    or any(len(values) != 1 for values in query.values())
                ):
                    raise ValueError("invalid query")
                limit = int(query.get("limit", ["50"])[0])
                if not 1 <= limit <= 100:
                    raise ValueError("invalid limit")
                after_id_raw = query.get("afterId", [None])[0]
                after_id = (
                    int(after_id_raw) if after_id_raw is not None else None
                )
                if after_id is not None and after_id < 0:
                    raise ValueError("invalid afterId")
                before_id_raw = query.get("beforeId", [None])[0]
                before_id = (
                    int(before_id_raw) if before_id_raw is not None else None
                )
                if before_id is not None and before_id < 1:
                    raise ValueError("invalid beforeId")
                if after_id is not None and before_id is not None:
                    raise ValueError("conflicting cursors")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid query"}
                )
                return
            notifications = self.app.store.notifications(
                self.app.devices,
                limit,
                after_id=after_id,
                before_id=before_id,
            )
            self.send_json(
                HTTPStatus.OK, {"notifications": notifications}
            )
            return
        if path == "/v1/devices":
            if self.authorize_api("pairing:create") is None:
                return
            self.send_json(
                HTTPStatus.OK,
                {"devices": sorted(self.app.devices)},
            )
            return
        if path == "/v1/devices/detail":
            if self.authorize_api("pairing:create") is None:
                return
            devices = self.app.store.get_devices()
            self.send_json(HTTPStatus.OK, {"devices": devices})
            return
        if not self.app.allow_viewer:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
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
        if path == "/v1/devices":
            if self.authorize_api("pairing:create") is None:
                return
            try:
                value = self.read_json_body(4_096)
                if set(value) - {"deviceId", "secretBase64", "description"}:
                    raise ValueError("unsupported request field")
                device_id = value.get("deviceId")
                secret_base64 = value.get("secretBase64")
                description = value.get("description", "")
                if (
                    not isinstance(device_id, str)
                    or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id)
                ):
                    raise ValueError("deviceId is required")
                if not isinstance(secret_base64, str) or not secret_base64:
                    raise ValueError("secretBase64 is required")
                if not isinstance(description, str):
                    raise ValueError("description must be a string")
                try:
                    secret_bytes = base64.b64decode(
                        secret_base64, validate=True
                    )
                except (binascii.Error, ValueError) as error:
                    raise ValueError("invalid secretBase64") from error
                if len(secret_bytes) < 32:
                    raise ValueError("secretBase64 is too short")
            except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid request"})
                return
            try:
                now_ms = int(time.time() * 1000)
                device = self.app.store.add_device(
                    device_id, secret_base64, description, now_ms
                )
            except ValueError as e:
                self.send_json(HTTPStatus.CONFLICT, {"error": str(e)})
                return
            self.app.refresh_devices()
            self.send_json(HTTPStatus.CREATED, {"device": device})
            return
        if path == "/v1/pairings":
            if not self.app.accept_ingestion:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            if self.authorize_api("pairing:create") is None:
                return
            if not self.rate_limit(
                "pairing-create",
                self.client_ip(),
                self.app.pairing_create_requests_per_minute,
            ):
                return
            try:
                value = self.read_json_body(4_096)
                if set(value) - {"deviceId", "expiresInSeconds"}:
                    raise ValueError("unsupported request field")
                device_id = value.get("deviceId")
                expires_in_seconds = value.get("expiresInSeconds", 300)
                if (
                    not isinstance(device_id, str)
                    or device_id not in self.app.devices
                ):
                    raise ValueError("invalid deviceId")
                if (
                    not isinstance(expires_in_seconds, int)
                    or isinstance(expires_in_seconds, bool)
                    or not MIN_PAIRING_EXPIRES_SECONDS
                    <= expires_in_seconds
                    <= MAX_PAIRING_EXPIRES_SECONDS
                ):
                    raise ValueError("invalid expiresInSeconds")
                if not self.app.pairing_public_endpoint:
                    raise RuntimeError("pairing endpoint is not configured")
                token = self.app.pairing_token_factory()
                if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
                    raise RuntimeError("pairing token generator failed")
                now_ms = int(time.time() * 1000)
                expires_at = self.app.store.create_pairing(
                    token,
                    device_id,
                    now_ms,
                    expires_in_seconds,
                )
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid request"}
                )
                return
            except RuntimeError:
                self.send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "pairing unavailable"},
                )
                return
            document = {
                "schemaVersion": 1,
                "type": "ca-connection-pairing",
                "endpoint": self.app.pairing_public_endpoint,
                "pairingToken": token,
            }
            if self.app.pairing_certificate_pin:
                document["certificatePinSha256Base64"] = (
                    self.app.pairing_certificate_pin
                )
            self.send_json(
                HTTPStatus.CREATED,
                {
                    "pairing": {
                        "deviceId": device_id,
                        "expiresAt": expires_at,
                        "payload": json.dumps(
                            document,
                            separators=(",", ":"),
                            ensure_ascii=True,
                        ),
                    }
                },
            )
            return
        if path == "/v1/pairings/claim":
            if not self.app.accept_ingestion:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            if not self.rate_limit(
                "pairing-claim",
                self.client_ip(),
                self.app.pairing_claim_requests_per_minute,
            ):
                return
            try:
                value = self.read_json_body(4_096)
                if set(value) != {"pairingToken"}:
                    raise ValueError("invalid request fields")
                token = value.get("pairingToken")
                if (
                    not isinstance(token, str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token)
                ):
                    raise ValueError("invalid pairing token")
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid request"}
                )
                return
            device_id = self.app.store.claim_pairing(
                token,
                int(time.time() * 1000),
            )
            secret = self.app.devices.get(device_id or "")
            if device_id is None or secret is None:
                self.send_json(
                    HTTPStatus.GONE,
                    {"error": "pairing expired or already used"},
                )
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "provisioning": {
                        "schemaVersion": 1,
                        "endpoint": self.app.pairing_public_endpoint,
                        "deviceId": device_id,
                        "sharedSecretBase64": base64.b64encode(secret).decode(
                            "ascii"
                        ),
                        "certificatePinSha256Base64": (
                            self.app.pairing_certificate_pin
                        ),
                        "enabled": True,
                    }
                },
            )
            return
        if path == "/v1/otp/claim":
            client_id = self.authorize_api("otp:claim")
            if client_id is None:
                return
            try:
                value = self.read_json_body()
                if set(value) - {"slotIndex", "maxAgeSeconds", "eventId"}:
                    raise ValueError("unsupported request field")
                slot_index = value.get("slotIndex")
                if slot_index is not None and (
                    not isinstance(slot_index, int)
                    or isinstance(slot_index, bool)
                    or slot_index not in (0, 1)
                ):
                    raise ValueError("invalid slotIndex")
                max_age_value = value.get(
                    "maxAgeSeconds", self.app.otp_max_age_seconds
                )
                if not isinstance(max_age_value, int) or isinstance(
                    max_age_value, bool
                ):
                    raise ValueError("invalid maxAgeSeconds")
                max_age_seconds = max_age_value
                if not 30 <= max_age_seconds <= 3600:
                    raise ValueError("invalid maxAgeSeconds")
                event_id = value.get("eventId")
                if event_id is not None and (
                    not isinstance(event_id, int)
                    or isinstance(event_id, bool)
                    or event_id < 1
                ):
                    raise ValueError("invalid eventId")
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid request"}
                )
                return
            claimed = self.app.store.claim_latest_otp(
                self.app.devices,
                client_id,
                int(time.time() * 1000),
                max_age_seconds,
                slot_index=slot_index,
                event_id=event_id,
            )
            if claimed is None:
                self.send_json(
                    HTTPStatus.NOT_FOUND, {"error": "no unclaimed OTP found"}
                )
            else:
                self.send_json(HTTPStatus.OK, {"otp": claimed})
            return
        if path == "/api/clear":
            if not self.app.allow_viewer:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
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
        device_id = self.headers.get("X-Gateway-Device", "")
        if not self.rate_limit(
            "ingest-ip",
            self.client_ip(),
            self.app.ingest_requests_per_minute,
        ):
            return
        body = self.rfile.read(length)
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
            or not 1 <= len(nonce) <= 128
            or not 1 <= len(idempotency_key) <= 128
            or not 1 <= len(signature) <= 128
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
        if not self.rate_limit(
            "ingest-device",
            device_id,
            self.app.device_requests_per_minute,
        ):
            return

        try:
            envelope = validate_envelope(json.loads(body))
            if envelope["schemaVersion"] != 2:
                raise ValueError("encrypted schemaVersion 2 required")
            decrypt_payload(envelope, device_id, secret)
            inserted = self.app.store.accept(
                device_id, idempotency_key, nonce, envelope, now_ms
            )
            self.app.store.prune(self.app.retention_days, now_ms)
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

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        # PUT /v1/devices/{device_id}
        if path.startswith("/v1/devices/"):
            if self.authorize_api("pairing:create") is None:
                return
            device_id = path[len("/v1/devices/"):]
            if not device_id or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid device_id"})
                return
            try:
                value = self.read_json_body(4_096)
                if (
                    set(value) - {"description", "secretBase64"}
                    or not value
                ):
                    raise ValueError("unsupported or empty request")
                description = value.get("description")
                secret_base64 = value.get("secretBase64")
                if description is not None and not isinstance(description, str):
                    raise ValueError("description must be a string")
                if secret_base64 is not None and not isinstance(secret_base64, str):
                    raise ValueError("secretBase64 must be a string")
            except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid request"})
                return
            try:
                device = self.app.store.update_device(
                    device_id,
                    description=description,
                    secret_base64=secret_base64,
                )
            except ValueError as e:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
                return
            if device is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "device not found"})
                return
            self.app.refresh_devices()
            self.send_json(HTTPStatus.OK, {"device": device})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        # DELETE /v1/devices/{device_id}
        if path.startswith("/v1/devices/"):
            if self.authorize_api("pairing:create") is None:
                return
            device_id = path[len("/v1/devices/"):]
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid device_id"})
                return
            deleted = self.app.store.delete_device(device_id)
            if not deleted:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "device not found"})
                return
            self.app.refresh_devices()
            self.send_json(HTTPStatus.OK, {"deleted": True})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})


class GatewayHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64

    def __init__(
        self,
        address: tuple[str, int],
        devices: dict[str, bytes],
        store: GatewayStore,
        accept_ingestion: bool = True,
        allow_viewer: bool = False,
        api_clients: Optional[dict[str, dict[str, Any]]] = None,
        server_settings: Optional[dict[str, Any]] = None,
        pairing_token_factory: Optional[Any] = None,
    ):
        super().__init__(address, GatewayHandler)
        self.devices = devices
        self.store = store
        self.accept_ingestion = accept_ingestion
        self.allow_viewer = allow_viewer
        self.api_clients = api_clients or {}
        settings = server_settings or {}
        self.pairing_public_endpoint = str(
            settings.get("pairing_public_endpoint", "")
        ).strip().rstrip("/")
        if self.pairing_public_endpoint:
            parsed_pairing_endpoint = urlparse(self.pairing_public_endpoint)
            if (
                parsed_pairing_endpoint.scheme != "https"
                or not parsed_pairing_endpoint.hostname
                or parsed_pairing_endpoint.username is not None
                or parsed_pairing_endpoint.password is not None
                or parsed_pairing_endpoint.query
                or parsed_pairing_endpoint.fragment
                or parsed_pairing_endpoint.path not in ("", "/")
            ):
                raise ValueError(
                    "pairing_public_endpoint must be an HTTPS origin"
                )
        self.pairing_certificate_pin = str(
            settings.get("pairing_certificate_pin_sha256_base64", "")
        ).strip()
        if self.pairing_certificate_pin:
            try:
                pin_bytes = base64.b64decode(
                    self.pairing_certificate_pin,
                    validate=True,
                )
            except (binascii.Error, ValueError) as error:
                raise ValueError(
                    "pairing_certificate_pin_sha256_base64 is invalid"
                ) from error
            if len(pin_bytes) != 32:
                raise ValueError(
                    "pairing_certificate_pin_sha256_base64 is invalid"
                )
        self.pairing_token_factory = pairing_token_factory or (
            lambda: secrets.token_urlsafe(32)
        )
        self.retention_days = integer_setting(
            settings,
            "retention_days",
            DEFAULT_RETENTION_DAYS,
            1,
            3650,
        )
        self.otp_max_age_seconds = integer_setting(
            settings,
            "otp_max_age_seconds",
            DEFAULT_OTP_MAX_AGE_SECONDS,
            30,
            3600,
        )
        self.ingest_requests_per_minute = integer_setting(
            settings,
            "ingest_requests_per_minute",
            DEFAULT_INGEST_REQUESTS_PER_MINUTE,
            1,
            100_000,
        )
        self.device_requests_per_minute = integer_setting(
            settings,
            "device_requests_per_minute",
            DEFAULT_DEVICE_REQUESTS_PER_MINUTE,
            1,
            100_000,
        )
        self.api_auth_requests_per_minute = integer_setting(
            settings,
            "api_auth_requests_per_minute",
            DEFAULT_API_AUTH_REQUESTS_PER_MINUTE,
            1,
            100_000,
        )
        self.api_requests_per_minute = integer_setting(
            settings,
            "api_requests_per_minute",
            DEFAULT_API_REQUESTS_PER_MINUTE,
            1,
            100_000,
        )
        self.pairing_create_requests_per_minute = integer_setting(
            settings,
            "pairing_create_requests_per_minute",
            DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE,
            1,
            10_000,
        )
        self.pairing_claim_requests_per_minute = integer_setting(
            settings,
            "pairing_claim_requests_per_minute",
            DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE,
            1,
            10_000,
        )
        trust_proxy_headers = settings.get("trust_proxy_headers", False)
        if not isinstance(trust_proxy_headers, bool):
            raise ValueError("trust_proxy_headers must be a boolean")
        self.trust_proxy_headers = trust_proxy_headers
        self.max_concurrent_requests = integer_setting(
            settings,
            "max_concurrent_requests",
            DEFAULT_MAX_CONCURRENT_REQUESTS,
            1,
            1024,
        )
        self._request_slots = threading.BoundedSemaphore(
            self.max_concurrent_requests
        )
        self.rate_limiter = SlidingWindowRateLimiter()

    def refresh_devices(self) -> None:
        """Reload devices from database."""
        self.devices = self.store.load_devices()

    def process_request(
        self,
        request: Any,
        client_address: tuple[str, int],
    ) -> None:
        if not self._request_slots.acquire(timeout=1):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(
        self,
        request: Any,
        client_address: tuple[str, int],
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


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


def load_api_clients(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    clients = {}
    for client_id, value in config.get("api_clients", {}).items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", client_id):
            raise ValueError(f"Invalid API client ID: {client_id}")
        token_sha256 = str(value.get("token_sha256", "")).lower()
        scopes = value.get("scopes", [])
        if not re.fullmatch(r"[0-9a-f]{64}", token_sha256):
            raise ValueError(f"Invalid API token hash for {client_id}")
        if not isinstance(scopes, list) or not all(
            isinstance(scope, str)
            and scope in {
                "messages:read",
                "otp:claim",
                "pairing:create",
                "*",
            }
            for scope in scopes
        ):
            raise ValueError(f"Invalid API scopes for {client_id}")
        clients[client_id] = {
            "token_sha256": token_sha256,
            "scopes": scopes,
        }
    return clients


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--viewer-port", type=int, default=8788)
    parser.add_argument("--config", type=Path, default=root / "config.json")
    parser.add_argument("--database", type=Path, default=root / "data/gateway.db")
    parser.add_argument(
        "--no-tls",
        action="store_true",
        help="Serve plain HTTP behind a trusted same-host reverse proxy.",
    )
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    api_clients = load_api_clients(config)
    server_settings = config.get("server", {})
    store = GatewayStore(args.database)

    # Migrate devices from config file to database if needed
    config_devices = {}
    try:
        config_devices = load_devices(args.config)
    except (ValueError, FileNotFoundError):
        pass
    if config_devices:
        migrated_devices = store.migrate_devices_from_config(config_devices)
        if migrated_devices > 0:
            print(f"Migrated {migrated_devices} device(s) from config to database")

    # Load devices from database
    devices = store.load_devices()
    if not devices:
        print("Warning: No devices configured")

    migrated = store.migrate_legacy_payloads(devices)
    server = GatewayHttpServer(
        (args.host, args.port),
        devices,
        store,
        allow_viewer=False,
        api_clients=api_clients,
        server_settings=server_settings,
    )
    if not args.no_tls:
        tls = config["tls"]
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(tls["certificate"], tls["private_key"])
        server.socket = context.wrap_socket(server.socket, server_side=True)
    if args.viewer_port > 0:
        viewer = GatewayHttpServer(
            ("127.0.0.1", args.viewer_port),
            devices,
            store,
            accept_ingestion=False,
            allow_viewer=True,
        )
        threading.Thread(target=viewer.serve_forever, daemon=True).start()
        print("Viewer: http://127.0.0.1:%d/" % args.viewer_port)
    scheme = "HTTP" if args.no_tls else "HTTPS"
    print(f"{scheme} gateway receiver listening on {args.host}:{args.port}")
    if migrated:
        print(f"Migrated {migrated} legacy payload(s) to encrypted storage")
    server.serve_forever()


if __name__ == "__main__":
    main()
