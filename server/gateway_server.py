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
SERVICE_VERSION = "0.4.1"
DEFAULT_RETENTION_DAYS = 30
DEFAULT_OTP_MAX_AGE_SECONDS = 600
DEFAULT_INGEST_REQUESTS_PER_MINUTE = 120
DEFAULT_DEVICE_REQUESTS_PER_MINUTE = 120
DEFAULT_API_AUTH_REQUESTS_PER_MINUTE = 120
DEFAULT_API_REQUESTS_PER_MINUTE = 60
DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE = 20
DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE = 20
DEFAULT_MAX_CONCURRENT_REQUESTS = 32
DEVICE_ONLINE_WINDOW_MS = 3 * 60 * 1000
DEVICE_STALE_WINDOW_MS = 15 * 60 * 1000
DEFAULT_OUTBOUND_COMMAND_EXPIRES_SECONDS = 300
MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS = 60
MAX_OUTBOUND_COMMAND_EXPIRES_SECONDS = 3600
OUTBOUND_COMMAND_LEASE_MS = 5 * 60 * 1000
MIN_PAIRING_EXPIRES_SECONDS = 60
MAX_PAIRING_EXPIRES_SECONDS = 600
MAX_RATE_LIMIT_IDENTITIES = 10_000
ALLOWED_EVENT_TYPES = {
    "INCOMING_SMS",
    "NOTIFICATION",
    "CALL_STATE",
    "CALL_IDENTITY",
    "OUTBOUND_SMS_STATUS",
    "DEVICE_STATE",
    "LOCAL_SELF_TEST",
}
OUTBOUND_COMMAND_STATUSES = {
    "QUEUED",
    "CLAIMED",
    "CREATED",
    "DISPATCHING",
    "SENT_TO_MODEM",
    "DELIVERED",
    "FAILED",
    "EXPIRED",
}
OUTBOUND_STATUS_ORDER = {
    "QUEUED": 0,
    "CLAIMED": 1,
    "CREATED": 2,
    "DISPATCHING": 3,
    "SENT_TO_MODEM": 4,
    "DELIVERED": 5,
    "FAILED": 5,
    "EXPIRED": 5,
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
                CREATE TABLE IF NOT EXISTS outbound_commands (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    command_id TEXT NOT NULL UNIQUE,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    device_id TEXT NOT NULL,
                    slot_index INTEGER NOT NULL,
                    envelope_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    claimed_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    last_result_code INTEGER,
                    error_detail TEXT
                );
                CREATE INDEX IF NOT EXISTS index_events_type_received
                    ON events(event_type, received_at DESC);
                CREATE INDEX IF NOT EXISTS index_pairing_sessions_expiry
                    ON pairing_sessions(expires_at);
                CREATE INDEX IF NOT EXISTS index_outbound_commands_device_status
                    ON outbound_commands(device_id, status, created_at);
                CREATE INDEX IF NOT EXISTS index_outbound_commands_created
                    ON outbound_commands(created_at DESC);
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    secret_base64 TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER,
                    retired_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS device_status (
                    device_id TEXT PRIMARY KEY,
                    observed_at INTEGER NOT NULL,
                    app_version TEXT,
                    version_code INTEGER,
                    target_sdk INTEGER,
                    android_version TEXT,
                    manufacturer TEXT,
                    model TEXT,
                    receive_mode TEXT,
                    default_sms_role INTEGER,
                    receive_sms_granted INTEGER,
                    send_sms_granted INTEGER,
                    read_phone_state_granted INTEGER,
                    last_incoming_sms_at INTEGER,
                    last_otp_at INTEGER,
                    last_ordinary_sms_at INTEGER,
                    last_receiver_action TEXT,
                    last_receiver_action_at INTEGER,
                    last_receiver_invoked_at INTEGER,
                    last_receiver_invoked_action TEXT,
                    last_receiver_parse_failure_at INTEGER,
                    last_receiver_parse_failure_reason TEXT,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(device_id) REFERENCES devices(device_id)
                        ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS device_lines (
                    device_id TEXT NOT NULL,
                    slot_index INTEGER NOT NULL,
                    subscription_id INTEGER,
                    carrier_name TEXT,
                    display_name TEXT,
                    is_active INTEGER NOT NULL,
                    observed_at INTEGER NOT NULL,
                    PRIMARY KEY(device_id, slot_index),
                    FOREIGN KEY(device_id) REFERENCES devices(device_id)
                        ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS admin_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    occurred_at INTEGER NOT NULL,
                    client_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    device_id TEXT,
                    outcome TEXT NOT NULL,
                    metadata_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS index_admin_audit_occurred
                    ON admin_audit_log(occurred_at DESC);
                CREATE TABLE IF NOT EXISTS gateway_groups (
                    group_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS gateway_group_members (
                    group_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    PRIMARY KEY(group_id, device_id),
                    FOREIGN KEY(group_id) REFERENCES gateway_groups(group_id)
                        ON DELETE CASCADE,
                    FOREIGN KEY(device_id) REFERENCES devices(device_id)
                        ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS gateway_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            device_columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(devices)").fetchall()
            }
            if "retired_at" not in device_columns:
                db.execute("ALTER TABLE devices ADD COLUMN retired_at INTEGER")
            status_columns = {
                row["name"]
                for row in db.execute(
                    "PRAGMA table_info(device_status)"
                ).fetchall()
            }
            for column_name, column_type in (
                ("last_receiver_invoked_at", "INTEGER"),
                ("last_receiver_invoked_action", "TEXT"),
                ("last_receiver_parse_failure_at", "INTEGER"),
                ("last_receiver_parse_failure_reason", "TEXT"),
            ):
                if column_name not in status_columns:
                    db.execute(
                        f"ALTER TABLE device_status "
                        f"ADD COLUMN {column_name} {column_type}"
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

    # ── Outbound SMS commands ─────────────────────────────────────

    def create_outbound_command(
        self,
        device_id: str,
        secret: bytes,
        slot_index: int,
        recipient: str,
        body: str,
        idempotency_key: str,
        now_ms: int,
        expires_in_seconds: int,
    ) -> dict[str, Any]:
        command_id = secrets.token_urlsafe(24)
        expires_at = now_ms + expires_in_seconds * 1000
        envelope = encrypt_payload(
            {
                "schemaVersion": 1,
                "deliveryId": command_id,
                "sourceEventId": command_id,
                "eventType": "OUTBOUND_SMS_COMMAND",
                "createdAt": now_ms,
                "subscriptionId": None,
                "slotIndex": slot_index,
                "payload": {
                    "recipient": recipient,
                    "body": body,
                },
            },
            device_id,
            secret,
        )
        with self._lock, self._connect() as db:
            existing = db.execute(
                """
                SELECT *
                FROM outbound_commands
                WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                existing_command = self._outbound_command_from_row(
                    existing,
                    secret,
                )
                if (
                    existing["device_id"] != device_id
                    or existing["slot_index"] != slot_index
                    or existing_command["recipient"] != recipient
                    or existing_command["body"] != body
                ):
                    raise ValueError("idempotency key conflict")
                return existing_command
            db.execute(
                """
                INSERT INTO outbound_commands(
                    command_id, idempotency_key, device_id, slot_index,
                    envelope_json, status, created_at, expires_at,
                    claimed_at, updated_at, last_result_code, error_detail
                ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, NULL, ?, NULL, NULL)
                """,
                (
                    command_id,
                    idempotency_key,
                    device_id,
                    slot_index,
                    json.dumps(
                        envelope,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ),
                    now_ms,
                    expires_at,
                    now_ms,
                ),
            )
            row = db.execute(
                "SELECT * FROM outbound_commands WHERE command_id = ?",
                (command_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("outbound command creation failed")
        return self._outbound_command_from_row(row, secret)

    def list_outbound_commands(
        self,
        devices: dict[str, bytes],
        limit: int,
        before_id: Optional[int] = None,
        device_id: Optional[str] = None,
        device_ids: Optional[set[str]] = None,
    ) -> list[dict[str, Any]]:
        clauses = []
        parameters: list[Any] = []
        if before_id is not None:
            clauses.append("id < ?")
            parameters.append(before_id)
        if device_id is not None:
            clauses.append("device_id = ?")
            parameters.append(device_id)
        if device_ids is not None:
            if not device_ids:
                return []
            placeholders = ",".join("?" for _ in device_ids)
            clauses.append(f"device_id IN ({placeholders})")
            parameters.extend(sorted(device_ids))
        parameters.append(min(max(limit, 1), 100))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        now_ms = int(time.time() * 1000)
        with self._lock, self._connect() as db:
            db.execute(
                """
                UPDATE outbound_commands
                SET status = 'EXPIRED', updated_at = ?
                WHERE status IN ('QUEUED', 'CLAIMED')
                  AND expires_at <= ?
                """,
                (now_ms, now_ms),
            )
            rows = db.execute(
                f"""
                SELECT *
                FROM outbound_commands
                {where}
                ORDER BY id DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        commands = []
        for row in rows:
            secret = devices.get(row["device_id"])
            if secret is not None:
                commands.append(self._outbound_command_from_row(row, secret))
        return commands

    def claim_outbound_commands(
        self,
        device_id: str,
        secret: bytes,
        limit: int,
        now_ms: int,
    ) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """
                UPDATE outbound_commands
                SET status = 'EXPIRED', updated_at = ?
                WHERE device_id = ?
                  AND status IN ('QUEUED', 'CLAIMED')
                  AND expires_at <= ?
                """,
                (now_ms, device_id, now_ms),
            )
            db.execute(
                """
                UPDATE outbound_commands
                SET status = 'QUEUED', claimed_at = NULL, updated_at = ?
                WHERE device_id = ?
                  AND status = 'CLAIMED'
                  AND claimed_at <= ?
                  AND expires_at > ?
                """,
                (
                    now_ms,
                    device_id,
                    now_ms - OUTBOUND_COMMAND_LEASE_MS,
                    now_ms,
                ),
            )
            rows = db.execute(
                """
                SELECT *
                FROM outbound_commands
                WHERE device_id = ?
                  AND status = 'QUEUED'
                  AND expires_at > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (device_id, now_ms, min(max(limit, 1), 10)),
            ).fetchall()
            if rows:
                command_ids = [row["command_id"] for row in rows]
                placeholders = ",".join("?" for _ in command_ids)
                db.execute(
                    f"""
                    UPDATE outbound_commands
                    SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
                    WHERE command_id IN ({placeholders})
                      AND status = 'QUEUED'
                    """,
                    [now_ms, now_ms, *command_ids],
                )
                rows = db.execute(
                    f"""
                    SELECT *
                    FROM outbound_commands
                    WHERE command_id IN ({placeholders})
                    ORDER BY id ASC
                    """,
                    command_ids,
                ).fetchall()
        return [
            self._outbound_command_from_row(row, secret)
            for row in rows
        ]

    def update_outbound_command_status(
        self,
        device_id: str,
        payload: dict[str, Any],
        now_ms: int,
    ) -> bool:
        command_id = payload.get("commandId")
        status = payload.get("status")
        result_code = payload.get("resultCode")
        error_detail = payload.get("errorDetail")
        if (
            not isinstance(command_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", command_id)
            or status not in OUTBOUND_COMMAND_STATUSES
            or status in {"QUEUED", "CLAIMED", "EXPIRED"}
            or (
                result_code is not None
                and (
                    not isinstance(result_code, int)
                    or isinstance(result_code, bool)
                )
            )
            or not (
                error_detail is None
                or isinstance(error_detail, str)
            )
        ):
            raise ValueError("invalid outbound status")
        normalized_error = (
            error_detail.strip()[:256] if isinstance(error_detail, str) else None
        )
        with self._lock, self._connect() as db:
            row = db.execute(
                """
                SELECT status
                FROM outbound_commands
                WHERE command_id = ? AND device_id = ?
                """,
                (command_id, device_id),
            ).fetchone()
            if row is None:
                return False
            current = str(row["status"])
            if current in {"DELIVERED", "FAILED", "EXPIRED"}:
                return True
            if OUTBOUND_STATUS_ORDER[status] < OUTBOUND_STATUS_ORDER[current]:
                return True
            db.execute(
                """
                UPDATE outbound_commands
                SET status = ?, updated_at = ?,
                    last_result_code = ?, error_detail = ?
                WHERE command_id = ? AND device_id = ?
                """,
                (
                    status,
                    now_ms,
                    result_code,
                    normalized_error,
                    command_id,
                    device_id,
                ),
            )
        return True

    def _outbound_command_from_row(
        self,
        row: sqlite3.Row,
        secret: bytes,
    ) -> dict[str, Any]:
        envelope = decrypt_payload(
            json.loads(row["envelope_json"]),
            row["device_id"],
            secret,
        )
        payload = envelope["payload"]
        return {
            "id": row["id"],
            "commandId": row["command_id"],
            "deviceId": row["device_id"],
            "slotIndex": row["slot_index"],
            "recipient": payload.get("recipient"),
            "body": payload.get("body"),
            "status": row["status"],
            "createdAt": row["created_at"],
            "expiresAt": row["expires_at"],
            "claimedAt": row["claimed_at"],
            "updatedAt": row["updated_at"],
            "lastResultCode": row["last_result_code"],
            "errorDetail": row["error_detail"],
        }

    # ── Device CRUD ──────────────────────────────────────────────

    @staticmethod
    def _device_health(
        last_seen_at: Optional[int],
        retired_at: Optional[int],
        now_ms: int,
    ) -> str:
        if retired_at is not None:
            return "RETIRED"
        if last_seen_at is None:
            return "NEVER"
        age = max(0, now_ms - last_seen_at)
        if age <= DEVICE_ONLINE_WINDOW_MS:
            return "ONLINE"
        if age <= DEVICE_STALE_WINDOW_MS:
            return "STALE"
        return "OFFLINE"

    def _device_from_row(
        self,
        row: sqlite3.Row,
        lines: list[dict[str, Any]],
        now_ms: int,
    ) -> dict[str, Any]:
        def bool_or_none(name: str) -> Optional[bool]:
            value = row[name]
            return None if value is None else bool(value)

        return {
            "deviceId": row["device_id"],
            "description": row["description"] or "",
            "createdAt": row["created_at"],
            "lastSeenAt": row["last_seen_at"],
            "retiredAt": row["retired_at"],
            "health": self._device_health(
                row["last_seen_at"],
                row["retired_at"],
                now_ms,
            ),
            "status": {
                "observedAt": row["observed_at"],
                "appVersion": row["app_version"],
                "versionCode": row["version_code"],
                "targetSdk": row["target_sdk"],
                "androidVersion": row["android_version"],
                "manufacturer": row["manufacturer"],
                "model": row["model"],
                "receiveMode": row["receive_mode"],
                "defaultSmsRole": bool_or_none("default_sms_role"),
                "permissions": {
                    "receiveSms": bool_or_none("receive_sms_granted"),
                    "sendSms": bool_or_none("send_sms_granted"),
                    "readPhoneState": bool_or_none(
                        "read_phone_state_granted"
                    ),
                },
                "lastIncomingSmsAt": row["last_incoming_sms_at"],
                "lastOtpAt": row["last_otp_at"],
                "lastOrdinarySmsAt": row["last_ordinary_sms_at"],
                "lastReceiverAction": row["last_receiver_action"],
                "lastReceiverActionAt": row["last_receiver_action_at"],
                "lastReceiverInvokedAt": row[
                    "last_receiver_invoked_at"
                ],
                "lastReceiverInvokedAction": row[
                    "last_receiver_invoked_action"
                ],
                "lastReceiverParseFailureAt": row[
                    "last_receiver_parse_failure_at"
                ],
                "lastReceiverParseFailureReason": row[
                    "last_receiver_parse_failure_reason"
                ],
                "lines": lines,
            },
        }

    def get_devices(self) -> list[dict[str, Any]]:
        """Return all devices from the database."""
        now_ms = int(time.time() * 1000)
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT d.device_id, d.description, d.created_at,
                       d.last_seen_at, d.retired_at,
                       s.observed_at, s.app_version, s.version_code,
                       s.target_sdk, s.android_version, s.manufacturer,
                       s.model, s.receive_mode, s.default_sms_role,
                       s.receive_sms_granted, s.send_sms_granted,
                       s.read_phone_state_granted,
                       s.last_incoming_sms_at, s.last_otp_at,
                       s.last_ordinary_sms_at, s.last_receiver_action,
                       s.last_receiver_action_at,
                       s.last_receiver_invoked_at,
                       s.last_receiver_invoked_action,
                       s.last_receiver_parse_failure_at,
                       s.last_receiver_parse_failure_reason
                FROM devices d
                LEFT JOIN device_status s ON s.device_id = d.device_id
                ORDER BY d.device_id
                """
            ).fetchall()
            line_rows = db.execute(
                """
                SELECT device_id, slot_index, subscription_id,
                       carrier_name, display_name, is_active, observed_at
                FROM device_lines
                ORDER BY device_id, slot_index
                """
            ).fetchall()
        lines_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for line in line_rows:
            lines_by_device[str(line["device_id"])].append(
                {
                    "slotIndex": line["slot_index"],
                    "subscriptionId": line["subscription_id"],
                    "carrierName": line["carrier_name"],
                    "displayName": line["display_name"],
                    "active": bool(line["is_active"]),
                    "observedAt": line["observed_at"],
                }
            )
        return [
            self._device_from_row(
                row,
                lines_by_device.get(str(row["device_id"]), []),
                now_ms,
            )
            for row in rows
        ]

    def get_device(self, device_id: str) -> Optional[dict[str, Any]]:
        """Return a single device by ID."""
        return next(
            (
                device
                for device in self.get_devices()
                if device["deviceId"] == device_id
            ),
            None,
        )

    def is_device_active(self, device_id: str) -> bool:
        with self._connect() as db:
            row = db.execute(
                """
                SELECT retired_at
                FROM devices
                WHERE device_id = ?
                """,
                (device_id,),
            ).fetchone()
        # Legacy/in-memory test configurations have no database device row.
        return row is None or row["retired_at"] is None

    def upsert_device_state(
        self,
        device_id: str,
        payload: dict[str, Any],
        now_ms: int,
    ) -> None:
        required_boolean_fields = (
            "defaultSmsRole",
            "receiveSmsGranted",
            "sendSmsGranted",
            "readPhoneStateGranted",
        )
        for name in required_boolean_fields:
            if not isinstance(payload.get(name), bool):
                raise ValueError(f"invalid {name}")
        observed_at = payload.get("observedAt")
        version_code = payload.get("versionCode")
        target_sdk = payload.get("targetSdk")
        if (
            not isinstance(observed_at, int)
            or isinstance(observed_at, bool)
            or observed_at < 0
            or not isinstance(version_code, int)
            or isinstance(version_code, bool)
            or version_code < 0
            or not isinstance(target_sdk, int)
            or isinstance(target_sdk, bool)
            or target_sdk < 1
        ):
            raise ValueError("invalid device state")
        string_fields = (
            "appVersion",
            "androidVersion",
            "manufacturer",
            "model",
            "receiveMode",
        )
        if any(
            not isinstance(payload.get(name), str)
            or not str(payload[name]).strip()
            or len(str(payload[name])) > 128
            for name in string_fields
        ):
            raise ValueError("invalid device state")
        receive_mode = str(payload["receiveMode"])
        if receive_mode not in {"OBSERVER", "DEFAULT_SMS"}:
            raise ValueError("invalid receiveMode")
        receiver_invoked_at = payload.get("receiverInvokedAt")
        receiver_parse_failure_at = payload.get(
            "receiverParseFailureAt"
        )
        for value in (receiver_invoked_at, receiver_parse_failure_at):
            if value is not None and (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value < 0
            ):
                raise ValueError("invalid receiver diagnostic")
        receiver_invoked_action = payload.get("receiverInvokedAction")
        if (
            receiver_invoked_action is not None
            and receiver_invoked_action not in {
                "SMS_RECEIVED",
                "SMS_DELIVER",
            }
        ):
            raise ValueError("invalid receiver diagnostic")
        receiver_parse_failure_reason = payload.get(
            "receiverParseFailureReason"
        )
        if (
            receiver_parse_failure_reason is not None
            and receiver_parse_failure_reason not in {
                "NO_MESSAGES",
                "PARSER_EXCEPTION",
                "PROCESSING_EXCEPTION",
            }
        ):
            raise ValueError("invalid receiver diagnostic")
        if (
            (receiver_invoked_at is None)
            != (receiver_invoked_action is None)
            or (receiver_parse_failure_at is None)
            != (receiver_parse_failure_reason is None)
            or (
                receiver_parse_failure_at is not None
                and receiver_invoked_at is None
            )
        ):
            raise ValueError("invalid receiver diagnostic")
        raw_lines = payload.get("lines")
        if not isinstance(raw_lines, list) or len(raw_lines) > 4:
            raise ValueError("invalid lines")
        lines: list[dict[str, Any]] = []
        seen_slots = set()
        for line in raw_lines:
            if not isinstance(line, dict) or set(line) - {
                "slotIndex",
                "subscriptionId",
                "carrierName",
                "displayName",
                "active",
            }:
                raise ValueError("invalid line")
            slot_index = line.get("slotIndex")
            subscription_id = line.get("subscriptionId")
            if (
                not isinstance(slot_index, int)
                or isinstance(slot_index, bool)
                or not 0 <= slot_index <= 3
                or slot_index in seen_slots
                or (
                    subscription_id is not None
                    and (
                        not isinstance(subscription_id, int)
                        or isinstance(subscription_id, bool)
                    )
                )
                or not isinstance(line.get("active"), bool)
            ):
                raise ValueError("invalid line")
            for name in ("carrierName", "displayName"):
                value = line.get(name)
                if value is not None and (
                    not isinstance(value, str) or len(value) > 128
                ):
                    raise ValueError("invalid line")
            seen_slots.add(slot_index)
            lines.append(line)
        with self._lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO device_status(
                    device_id, observed_at, app_version, version_code,
                    target_sdk, android_version, manufacturer, model,
                    receive_mode, default_sms_role, receive_sms_granted,
                    send_sms_granted, read_phone_state_granted,
                    last_receiver_invoked_at,
                    last_receiver_invoked_action,
                    last_receiver_parse_failure_at,
                    last_receiver_parse_failure_reason,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    observed_at = excluded.observed_at,
                    app_version = excluded.app_version,
                    version_code = excluded.version_code,
                    target_sdk = excluded.target_sdk,
                    android_version = excluded.android_version,
                    manufacturer = excluded.manufacturer,
                    model = excluded.model,
                    receive_mode = excluded.receive_mode,
                    default_sms_role = excluded.default_sms_role,
                    receive_sms_granted = excluded.receive_sms_granted,
                    send_sms_granted = excluded.send_sms_granted,
                    read_phone_state_granted =
                        excluded.read_phone_state_granted,
                    last_receiver_invoked_at = CASE
                        WHEN excluded.last_receiver_invoked_at IS NOT NULL
                          AND (
                            device_status.last_receiver_invoked_at IS NULL
                            OR excluded.last_receiver_invoked_at >=
                               device_status.last_receiver_invoked_at
                          )
                        THEN excluded.last_receiver_invoked_at
                        ELSE device_status.last_receiver_invoked_at
                    END,
                    last_receiver_invoked_action = CASE
                        WHEN excluded.last_receiver_invoked_at IS NOT NULL
                          AND (
                            device_status.last_receiver_invoked_at IS NULL
                            OR excluded.last_receiver_invoked_at >=
                               device_status.last_receiver_invoked_at
                          )
                        THEN excluded.last_receiver_invoked_action
                        ELSE device_status.last_receiver_invoked_action
                    END,
                    last_receiver_parse_failure_at = CASE
                        WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
                          AND (
                            device_status.last_receiver_parse_failure_at IS NULL
                            OR excluded.last_receiver_parse_failure_at >=
                               device_status.last_receiver_parse_failure_at
                          )
                        THEN excluded.last_receiver_parse_failure_at
                        ELSE device_status.last_receiver_parse_failure_at
                    END,
                    last_receiver_parse_failure_reason = CASE
                        WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
                          AND (
                            device_status.last_receiver_parse_failure_at IS NULL
                            OR excluded.last_receiver_parse_failure_at >=
                               device_status.last_receiver_parse_failure_at
                          )
                        THEN excluded.last_receiver_parse_failure_reason
                        ELSE device_status.last_receiver_parse_failure_reason
                    END,
                    updated_at = excluded.updated_at
                """,
                (
                    device_id,
                    observed_at,
                    str(payload["appVersion"]).strip(),
                    version_code,
                    target_sdk,
                    str(payload["androidVersion"]).strip(),
                    str(payload["manufacturer"]).strip(),
                    str(payload["model"]).strip(),
                    receive_mode,
                    int(payload["defaultSmsRole"]),
                    int(payload["receiveSmsGranted"]),
                    int(payload["sendSmsGranted"]),
                    int(payload["readPhoneStateGranted"]),
                    receiver_invoked_at,
                    receiver_invoked_action,
                    receiver_parse_failure_at,
                    receiver_parse_failure_reason,
                    now_ms,
                ),
            )
            db.execute(
                "DELETE FROM device_lines WHERE device_id = ?",
                (device_id,),
            )
            for line in lines:
                db.execute(
                    """
                    INSERT INTO device_lines(
                        device_id, slot_index, subscription_id,
                        carrier_name, display_name, is_active, observed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        device_id,
                        line["slotIndex"],
                        line.get("subscriptionId"),
                        line.get("carrierName"),
                        line.get("displayName"),
                        int(line["active"]),
                        observed_at,
                    ),
                )

    def observe_incoming_sms(
        self,
        device_id: str,
        payload: dict[str, Any],
        received_at: int,
    ) -> None:
        body = payload.get("body")
        candidates = extract_otp_candidates(body if isinstance(body, str) else "")
        action = payload.get("action")
        if action not in {"SMS_RECEIVED", "SMS_DELIVER"}:
            action = None
        with self._lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO device_status(
                    device_id, observed_at, updated_at,
                    last_incoming_sms_at, last_otp_at,
                    last_ordinary_sms_at, last_receiver_action,
                    last_receiver_action_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    last_incoming_sms_at = excluded.last_incoming_sms_at,
                    last_otp_at = COALESCE(
                        excluded.last_otp_at,
                        device_status.last_otp_at
                    ),
                    last_ordinary_sms_at = COALESCE(
                        excluded.last_ordinary_sms_at,
                        device_status.last_ordinary_sms_at
                    ),
                    last_receiver_action = COALESCE(
                        excluded.last_receiver_action,
                        device_status.last_receiver_action
                    ),
                    last_receiver_action_at = COALESCE(
                        excluded.last_receiver_action_at,
                        device_status.last_receiver_action_at
                    ),
                    updated_at = excluded.updated_at
                """,
                (
                    device_id,
                    received_at,
                    received_at,
                    received_at,
                    received_at if candidates else None,
                    received_at if not candidates else None,
                    action,
                    received_at if action else None,
                ),
            )

    def retire_device(self, device_id: str, now_ms: int) -> bool:
        with self._lock, self._connect() as db:
            cursor = db.execute(
                """
                UPDATE devices
                SET retired_at = COALESCE(retired_at, ?)
                WHERE device_id = ?
                """,
                (now_ms, device_id),
            )
            db.execute(
                """
                UPDATE pairing_sessions
                SET consumed_at = COALESCE(consumed_at, ?)
                WHERE device_id = ?
                """,
                (now_ms, device_id),
            )
            db.execute(
                """
                UPDATE outbound_commands
                SET status = 'EXPIRED', updated_at = ?
                WHERE device_id = ? AND status IN ('QUEUED', 'CLAIMED')
                """,
                (now_ms, device_id),
            )
            return cursor.rowcount == 1

    def restore_device(self, device_id: str) -> bool:
        with self._lock, self._connect() as db:
            cursor = db.execute(
                "UPDATE devices SET retired_at = NULL WHERE device_id = ?",
                (device_id,),
            )
            return cursor.rowcount == 1

    def purge_device(self, device_id: str) -> bool:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT 1 FROM devices WHERE device_id = ?",
                (device_id,),
            ).fetchone()
            if existing is None:
                return False
            event_ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM events WHERE device_id = ?",
                    (device_id,),
                ).fetchall()
            ]
            if event_ids:
                placeholders = ",".join("?" for _ in event_ids)
                db.execute(
                    f"DELETE FROM otp_claims WHERE event_id IN ({placeholders})",
                    event_ids,
                )
            for table in (
                "events",
                "request_nonces",
                "pairing_sessions",
                "outbound_commands",
                "device_lines",
                "device_status",
                "gateway_group_members",
            ):
                db.execute(
                    f"DELETE FROM {table} WHERE device_id = ?",
                    (device_id,),
                )
            db.execute(
                "DELETE FROM devices WHERE device_id = ?",
                (device_id,),
            )
            return True

    def record_audit(
        self,
        client_id: str,
        action: str,
        device_id: Optional[str],
        outcome: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        safe_metadata = metadata or {}
        with self._lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO admin_audit_log(
                    occurred_at, client_id, action,
                    device_id, outcome, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    int(time.time() * 1000),
                    client_id,
                    action,
                    device_id,
                    outcome,
                    json.dumps(
                        safe_metadata,
                        separators=(",", ":"),
                        ensure_ascii=True,
                    ),
                ),
            )

    def list_audit(
        self,
        limit: int,
        before_id: Optional[int] = None,
        device_ids: Optional[set[str]] = None,
    ) -> list[dict[str, Any]]:
        clauses = []
        parameters: list[Any] = []
        if before_id is not None:
            clauses.append("id < ?")
            parameters.append(before_id)
        if device_ids is not None:
            if not device_ids:
                return []
            placeholders = ",".join("?" for _ in device_ids)
            clauses.append(f"device_id IN ({placeholders})")
            parameters.extend(sorted(device_ids))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(min(max(limit, 1), 100))
        with self._connect() as db:
            rows = db.execute(
                f"""
                SELECT id, occurred_at, client_id, action,
                       device_id, outcome, metadata_json
                FROM admin_audit_log
                {where}
                ORDER BY id DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        result = [
            {
                "id": row["id"],
                "occurredAt": row["occurred_at"],
                "clientId": row["client_id"],
                "action": row["action"],
                "deviceId": row["device_id"],
                "outcome": row["outcome"],
                "metadata": json.loads(row["metadata_json"]),
            }
            for row in rows
        ]
        return result

    def list_groups(
        self,
        allowed_device_ids: Optional[set[str]] = None,
    ) -> list[dict[str, Any]]:
        with self._connect() as db:
            groups = db.execute(
                """
                SELECT group_id, name, created_at, updated_at
                FROM gateway_groups
                ORDER BY name COLLATE NOCASE, group_id
                """
            ).fetchall()
            members = db.execute(
                """
                SELECT group_id, device_id
                FROM gateway_group_members
                ORDER BY device_id
                """
            ).fetchall()
        by_group: dict[str, list[str]] = defaultdict(list)
        for member in members:
            device_id = str(member["device_id"])
            if (
                allowed_device_ids is None
                or device_id in allowed_device_ids
            ):
                by_group[str(member["group_id"])].append(device_id)
        result = [
            {
                "groupId": row["group_id"],
                "name": row["name"],
                "deviceIds": by_group.get(str(row["group_id"]), []),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in groups
        ]
        if allowed_device_ids is not None:
            result = [group for group in result if group["deviceIds"]]
        return result

    def group_device_ids(self, group_id: str) -> Optional[set[str]]:
        with self._connect() as db:
            exists = db.execute(
                "SELECT 1 FROM gateway_groups WHERE group_id = ?",
                (group_id,),
            ).fetchone()
            if exists is None:
                return None
            rows = db.execute(
                """
                SELECT device_id
                FROM gateway_group_members
                WHERE group_id = ?
                """,
                (group_id,),
            ).fetchall()
        return {str(row["device_id"]) for row in rows}

    def create_group(
        self,
        group_id: str,
        name: str,
        device_ids: list[str],
        now_ms: int,
    ) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", group_id):
            raise ValueError("invalid groupId")
        normalized_name = name.strip()
        if not 1 <= len(normalized_name) <= 128:
            raise ValueError("invalid group name")
        if len(set(device_ids)) != len(device_ids):
            raise ValueError("duplicate deviceId")
        with self._lock, self._connect() as db:
            known = {
                str(row["device_id"])
                for row in db.execute(
                    "SELECT device_id FROM devices"
                ).fetchall()
            }
            if not set(device_ids).issubset(known):
                raise ValueError("unknown deviceId")
            try:
                db.execute(
                    """
                    INSERT INTO gateway_groups(
                        group_id, name, created_at, updated_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (group_id, normalized_name, now_ms, now_ms),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("group already exists") from error
            for device_id in device_ids:
                db.execute(
                    """
                    INSERT INTO gateway_group_members(group_id, device_id)
                    VALUES (?, ?)
                    """,
                    (group_id, device_id),
                )
        return next(
            group
            for group in self.list_groups()
            if group["groupId"] == group_id
        )

    def update_group(
        self,
        group_id: str,
        name: Optional[str],
        device_ids: Optional[list[str]],
        now_ms: int,
    ) -> Optional[dict[str, Any]]:
        normalized_name = name.strip() if name is not None else None
        if normalized_name is not None and not 1 <= len(normalized_name) <= 128:
            raise ValueError("invalid group name")
        if device_ids is not None and len(set(device_ids)) != len(device_ids):
            raise ValueError("duplicate deviceId")
        with self._lock, self._connect() as db:
            if db.execute(
                "SELECT 1 FROM gateway_groups WHERE group_id = ?",
                (group_id,),
            ).fetchone() is None:
                return None
            if device_ids is not None:
                known = {
                    str(row["device_id"])
                    for row in db.execute(
                        "SELECT device_id FROM devices"
                    ).fetchall()
                }
                if not set(device_ids).issubset(known):
                    raise ValueError("unknown deviceId")
                db.execute(
                    "DELETE FROM gateway_group_members WHERE group_id = ?",
                    (group_id,),
                )
                for device_id in device_ids:
                    db.execute(
                        """
                        INSERT INTO gateway_group_members(group_id, device_id)
                        VALUES (?, ?)
                        """,
                        (group_id, device_id),
                    )
            if normalized_name is not None:
                db.execute(
                    """
                    UPDATE gateway_groups
                    SET name = ?, updated_at = ?
                    WHERE group_id = ?
                    """,
                    (normalized_name, now_ms, group_id),
                )
            else:
                db.execute(
                    """
                    UPDATE gateway_groups
                    SET updated_at = ?
                    WHERE group_id = ?
                    """,
                    (now_ms, group_id),
                )
        return next(
            group
            for group in self.list_groups()
            if group["groupId"] == group_id
        )

    def delete_group(self, group_id: str) -> bool:
        with self._lock, self._connect() as db:
            db.execute(
                "DELETE FROM gateway_group_members WHERE group_id = ?",
                (group_id,),
            )
            cursor = db.execute(
                "DELETE FROM gateway_groups WHERE group_id = ?",
                (group_id,),
            )
            return cursor.rowcount == 1

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
        created = self.get_device(device_id)
        if created is None:
            raise RuntimeError("device creation failed")
        return created

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
                    command_rows = db.execute(
                        """
                        SELECT id, envelope_json
                        FROM outbound_commands
                        WHERE device_id = ?
                        """,
                        (device_id,),
                    ).fetchall()
                    for command_row in command_rows:
                        envelope = decrypt_payload(
                            json.loads(command_row["envelope_json"]),
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
                            """
                            UPDATE outbound_commands
                            SET envelope_json = ?
                            WHERE id = ?
                            """,
                            (
                                json.dumps(
                                    reencrypted,
                                    separators=(",", ":"),
                                    ensure_ascii=False,
                                ),
                                command_row["id"],
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
        return self.get_device(device_id)

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

    def record_request_nonce(
        self,
        device_id: str,
        nonce: str,
        now_ms: int,
    ) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                "DELETE FROM request_nonces WHERE seen_at < ?",
                (now_ms - NONCE_RETENTION_MS,),
            )
            try:
                db.execute(
                    """
                    INSERT INTO request_nonces(device_id, nonce, seen_at)
                    VALUES (?, ?, ?)
                    """,
                    (device_id, nonce, now_ms),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("replayed nonce") from error

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
        device_id: Optional[str] = None,
        device_ids: Optional[set[str]] = None,
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
        if device_id is not None:
            clauses.append("device_id = ?")
            parameters.append(device_id)
        if device_ids is not None:
            if not device_ids:
                return []
            placeholders = ",".join("?" for _ in device_ids)
            clauses.append(f"device_id IN ({placeholders})")
            parameters.extend(sorted(device_ids))
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
        device_id: Optional[str] = None,
        device_ids: Optional[set[str]] = None,
    ) -> list[dict[str, Any]]:
        clauses = ["event_type = 'NOTIFICATION'"]
        parameters: list[Any] = []
        if after_id is not None:
            clauses.append("id > ?")
            parameters.append(after_id)
        if before_id is not None:
            clauses.append("id < ?")
            parameters.append(before_id)
        if device_id is not None:
            clauses.append("device_id = ?")
            parameters.append(device_id)
        if device_ids is not None:
            if not device_ids:
                return []
            placeholders = ",".join("?" for _ in device_ids)
            clauses.append(f"device_id IN ({placeholders})")
            parameters.extend(sorted(device_ids))
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
        device_id: Optional[str] = None,
        device_ids: Optional[set[str]] = None,
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
        if device_id is not None:
            clauses.append("e.device_id = ?")
            parameters.append(device_id)
        if device_ids is not None:
            if not device_ids:
                return None
            placeholders = ",".join("?" for _ in device_ids)
            clauses.append(f"e.device_id IN ({placeholders})")
            parameters.extend(sorted(device_ids))
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
            db.execute("DELETE FROM outbound_commands")


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

    def api_allowed_device_ids(
        self,
        client_id: str,
    ) -> Optional[set[str]]:
        configured = self.app.api_clients[client_id].get(
            "allowed_device_ids"
        )
        return set(configured) if configured is not None else None

    def api_can_access_device(
        self,
        client_id: str,
        device_id: str,
    ) -> bool:
        allowed = self.api_allowed_device_ids(client_id)
        return allowed is None or device_id in allowed

    def require_api_device_access(
        self,
        client_id: str,
        device_id: str,
    ) -> bool:
        if self.api_can_access_device(client_id, device_id):
            return True
        self.send_json(
            HTTPStatus.FORBIDDEN,
            {"error": "device access denied"},
        )
        return False

    def api_device_secrets(self, client_id: str) -> dict[str, bytes]:
        allowed = self.api_allowed_device_ids(client_id)
        if allowed is None:
            return dict(self.app.devices)
        return {
            device_id: secret
            for device_id, secret in self.app.devices.items()
            if device_id in allowed
        }

    def resolve_api_group_devices(
        self,
        client_id: str,
        group_id: str,
    ) -> Optional[set[str]]:
        group_devices = self.app.store.group_device_ids(group_id)
        if group_devices is None:
            self.send_json(
                HTTPStatus.NOT_FOUND,
                {"error": "device group not found"},
            )
            return None
        allowed = self.api_allowed_device_ids(client_id)
        if allowed is None:
            return group_devices
        accessible = group_devices.intersection(allowed)
        if not accessible:
            # Do not let a scoped client probe the existence of groups that
            # contain no device it is allowed to see.
            self.send_json(
                HTTPStatus.NOT_FOUND,
                {"error": "device group not found"},
            )
            return None
        return accessible

    def authorize_device_request(
        self,
        body: bytes,
    ) -> Optional[tuple[str, bytes]]:
        if not self.rate_limit(
            "device-auth-ip",
            self.client_ip(),
            self.app.ingest_requests_per_minute,
        ):
            return None
        device_id = self.headers.get("X-Gateway-Device", "")
        nonce = self.headers.get("X-Gateway-Nonce", "")
        idempotency_key = self.headers.get("Idempotency-Key", "")
        signature = self.headers.get("X-Gateway-Signature", "")
        try:
            timestamp_ms = int(self.headers.get("X-Gateway-Timestamp", ""))
        except ValueError:
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "invalid timestamp"},
            )
            return None
        secret = self.app.devices.get(device_id)
        now_ms = int(time.time() * 1000)
        if (
            secret is None
            or not self.app.store.is_device_active(device_id)
            or not 1 <= len(nonce) <= 128
            or not 1 <= len(idempotency_key) <= 128
            or not 1 <= len(signature) <= 128
            or abs(now_ms - timestamp_ms) > MAX_CLOCK_SKEW_MS
        ):
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "authentication failed"},
            )
            return None
        expected = expected_signature(
            secret,
            timestamp_ms,
            nonce,
            device_id,
            idempotency_key,
            body,
        )
        if not hmac.compare_digest(expected, signature):
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "authentication failed"},
            )
            return None
        if not self.rate_limit(
            "device",
            device_id,
            self.app.device_requests_per_minute,
        ):
            return None
        try:
            self.app.store.record_request_nonce(device_id, nonce, now_ms)
        except ValueError:
            self.send_json(
                HTTPStatus.CONFLICT,
                {"error": "replayed nonce"},
            )
            return None
        self.app.store.touch_device(device_id, now_ms)
        return device_id, secret

    def read_json_body(self, maximum_bytes: int = 16_384) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("application/json is required")
        body = self.read_body_bytes(maximum_bytes)
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError("body must be a JSON object")
        return value

    def read_body_bytes(self, maximum_bytes: int = 16_384) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("invalid content length") from error
        if length <= 0 or length > maximum_bytes:
            raise ValueError("invalid body size")
        return self.rfile.read(length)

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
            client_id = self.authorize_api("messages:read")
            if client_id is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {
                        "limit",
                        "afterId",
                        "beforeId",
                        "slotIndex",
                        "deviceId",
                        "groupId",
                    }
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
                device_id = query.get("deviceId", [None])[0]
                if device_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    device_id,
                ):
                    raise ValueError("invalid deviceId")
                group_id = query.get("groupId", [None])[0]
                if group_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    group_id,
                ):
                    raise ValueError("invalid groupId")
                if device_id is not None and group_id is not None:
                    raise ValueError("conflicting device filters")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid query"}
                )
                return
            if (
                device_id is not None
                and not self.require_api_device_access(
                    client_id,
                    device_id,
                )
            ):
                return
            accessible_ids = set(self.api_device_secrets(client_id))
            if group_id is not None:
                group_ids = self.resolve_api_group_devices(
                    client_id,
                    group_id,
                )
                if group_ids is None:
                    return
                accessible_ids.intersection_update(group_ids)
            messages = self.app.store.incoming_messages(
                self.api_device_secrets(client_id),
                limit,
                after_id=after_id,
                before_id=before_id,
                slot_index=slot_index,
                device_id=device_id,
                device_ids=accessible_ids,
            )
            self.send_json(HTTPStatus.OK, {"messages": messages})
            return
        if path == "/v1/notifications":
            client_id = self.authorize_api("messages:read")
            if client_id is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {
                        "limit",
                        "afterId",
                        "beforeId",
                        "deviceId",
                        "groupId",
                    }
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
                device_id = query.get("deviceId", [None])[0]
                if device_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    device_id,
                ):
                    raise ValueError("invalid deviceId")
                group_id = query.get("groupId", [None])[0]
                if group_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    group_id,
                ):
                    raise ValueError("invalid groupId")
                if device_id is not None and group_id is not None:
                    raise ValueError("conflicting device filters")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "invalid query"}
                )
                return
            if (
                device_id is not None
                and not self.require_api_device_access(
                    client_id,
                    device_id,
                )
            ):
                return
            accessible_ids = set(self.api_device_secrets(client_id))
            if group_id is not None:
                group_ids = self.resolve_api_group_devices(
                    client_id,
                    group_id,
                )
                if group_ids is None:
                    return
                accessible_ids.intersection_update(group_ids)
            notifications = self.app.store.notifications(
                self.api_device_secrets(client_id),
                limit,
                after_id=after_id,
                before_id=before_id,
                device_id=device_id,
                device_ids=accessible_ids,
            )
            self.send_json(
                HTTPStatus.OK, {"notifications": notifications}
            )
            return
        if path == "/v1/outbound-messages":
            client_id = self.authorize_api("messages:send")
            if client_id is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {"limit", "beforeId", "deviceId", "groupId"}
                    or any(len(values) != 1 for values in query.values())
                ):
                    raise ValueError("invalid query")
                limit = int(query.get("limit", ["50"])[0])
                if not 1 <= limit <= 100:
                    raise ValueError("invalid limit")
                before_id_raw = query.get("beforeId", [None])[0]
                before_id = (
                    int(before_id_raw) if before_id_raw is not None else None
                )
                if before_id is not None and before_id < 1:
                    raise ValueError("invalid beforeId")
                device_id = query.get("deviceId", [None])[0]
                if device_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    device_id,
                ):
                    raise ValueError("invalid deviceId")
                group_id = query.get("groupId", [None])[0]
                if group_id is not None and not re.fullmatch(
                    r"[A-Za-z0-9._-]{1,64}",
                    group_id,
                ):
                    raise ValueError("invalid groupId")
                if device_id is not None and group_id is not None:
                    raise ValueError("conflicting device filters")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid query"},
                )
                return
            if (
                device_id is not None
                and not self.require_api_device_access(
                    client_id,
                    device_id,
                )
            ):
                return
            accessible_ids = set(self.api_device_secrets(client_id))
            if group_id is not None:
                group_ids = self.resolve_api_group_devices(
                    client_id,
                    group_id,
                )
                if group_ids is None:
                    return
                accessible_ids.intersection_update(group_ids)
            commands = self.app.store.list_outbound_commands(
                self.api_device_secrets(client_id),
                limit,
                before_id=before_id,
                device_id=device_id,
                device_ids=accessible_ids,
            )
            self.send_json(
                HTTPStatus.OK,
                {"outboundMessages": commands},
            )
            return
        if path == "/v1/devices":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "devices": sorted(
                        device_id
                        for device_id in self.api_device_secrets(client_id)
                        if self.app.store.is_device_active(device_id)
                    )
                },
            )
            return
        if path == "/v1/devices/detail":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            allowed = self.api_allowed_device_ids(client_id)
            devices = [
                device
                for device in self.app.store.get_devices()
                if allowed is None
                or device["deviceId"] in allowed
            ]
            self.send_json(HTTPStatus.OK, {"devices": devices})
            return
        if path == "/v1/device-groups":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "groups": self.app.store.list_groups(
                        self.api_allowed_device_ids(client_id)
                    )
                },
            )
            return
        if path == "/v1/audit-log":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            query = parse_qs(parsed.query)
            try:
                if (
                    set(query) - {"limit", "beforeId"}
                    or any(len(values) != 1 for values in query.values())
                ):
                    raise ValueError("invalid query")
                limit = int(query.get("limit", ["50"])[0])
                before_raw = query.get("beforeId", [None])[0]
                before_id = int(before_raw) if before_raw is not None else None
                if not 1 <= limit <= 100 or (
                    before_id is not None and before_id < 1
                ):
                    raise ValueError("invalid query")
            except (TypeError, ValueError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid query"},
                )
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "entries": self.app.store.list_audit(
                        limit,
                        before_id=before_id,
                        device_ids=self.api_allowed_device_ids(client_id),
                    )
                },
            )
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
        if path == "/v1/device-groups":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            if self.api_allowed_device_ids(client_id) is not None:
                self.send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": "global device access required"},
                )
                return
            try:
                value = self.read_json_body(8_192)
                if set(value) != {"groupId", "name", "deviceIds"}:
                    raise ValueError("invalid request fields")
                group_id = value.get("groupId")
                name = value.get("name")
                device_ids = value.get("deviceIds")
                if (
                    not isinstance(group_id, str)
                    or not re.fullmatch(
                        r"[A-Za-z0-9._-]{1,64}",
                        group_id,
                    )
                    or not isinstance(name, str)
                    or not isinstance(device_ids, list)
                    or not all(
                        isinstance(device_id, str)
                        and re.fullmatch(
                            r"[A-Za-z0-9._-]{1,64}",
                            device_id,
                        )
                        for device_id in device_ids
                    )
                    or any(
                        not self.api_can_access_device(
                            client_id,
                            device_id,
                        )
                        for device_id in device_ids
                    )
                ):
                    raise ValueError("invalid device group")
                group = self.app.store.create_group(
                    group_id,
                    name,
                    device_ids,
                    int(time.time() * 1000),
                )
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ) as error:
                status = (
                    HTTPStatus.CONFLICT
                    if str(error) == "group already exists"
                    else HTTPStatus.BAD_REQUEST
                )
                self.send_json(status, {"error": str(error)})
                return
            self.app.store.record_audit(
                client_id,
                "DEVICE_GROUP_CREATE",
                None,
                "SUCCESS",
                {"groupId": group_id, "deviceCount": len(device_ids)},
            )
            self.send_json(HTTPStatus.CREATED, {"group": group})
            return
        lifecycle_match = re.fullmatch(
            r"/v1/devices/([A-Za-z0-9._-]{1,64})/(restore|purge)",
            path,
        )
        if lifecycle_match:
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            device_id, action = lifecycle_match.groups()
            if not self.require_api_device_access(client_id, device_id):
                return
            if action == "restore":
                try:
                    value = self.read_json_body(1_024)
                    if value:
                        raise ValueError("empty request required")
                except (
                    TypeError,
                    ValueError,
                    UnicodeDecodeError,
                    json.JSONDecodeError,
                ):
                    self.send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "invalid request"},
                    )
                    return
                restored = self.app.store.restore_device(device_id)
                if not restored:
                    self.send_json(
                        HTTPStatus.NOT_FOUND,
                        {"error": "device not found"},
                    )
                    return
                self.app.store.record_audit(
                    client_id,
                    "DEVICE_RESTORE",
                    device_id,
                    "SUCCESS",
                )
                self.app.refresh_devices()
                self.send_json(
                    HTTPStatus.OK,
                    {"device": self.app.store.get_device(device_id)},
                )
                return
            try:
                value = self.read_json_body(2_048)
                if value != {
                    "confirmation": f"PURGE {device_id}"
                }:
                    raise ValueError("confirmation mismatch")
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "confirmation required"},
                )
                return
            purged = self.app.store.purge_device(device_id)
            if not purged:
                self.send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": "device not found"},
                )
                return
            self.app.store.record_audit(
                client_id,
                "DEVICE_PURGE",
                device_id,
                "SUCCESS",
            )
            self.app.refresh_devices()
            self.send_json(HTTPStatus.OK, {"purged": True})
            return
        if path == "/v1/device-commands/claim":
            if not self.app.accept_ingestion:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                if self.headers.get("Content-Type", "").split(
                    ";", 1
                )[0].strip().lower() != "application/json":
                    raise ValueError("application/json is required")
                body = self.read_body_bytes(4_096)
            except ValueError:
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid request"},
                )
                return
            authorized = self.authorize_device_request(body)
            if authorized is None:
                return
            device_id, secret = authorized
            try:
                value = json.loads(body)
                if not isinstance(value, dict) or set(value) - {"limit"}:
                    raise ValueError("invalid request fields")
                limit = value.get("limit", 5)
                if (
                    not isinstance(limit, int)
                    or isinstance(limit, bool)
                    or not 1 <= limit <= 10
                ):
                    raise ValueError("invalid limit")
            except (TypeError, ValueError, json.JSONDecodeError):
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid request"},
                )
                return
            commands = self.app.store.claim_outbound_commands(
                device_id,
                secret,
                limit,
                int(time.time() * 1000),
            )
            self.send_json(
                HTTPStatus.OK,
                {"commands": commands},
            )
            return
        if path == "/v1/outbound-messages":
            client_id = self.authorize_api("messages:send")
            if client_id is None:
                return
            try:
                value = self.read_json_body(16_384)
                if set(value) - {
                    "deviceId",
                    "slotIndex",
                    "recipient",
                    "body",
                    "expiresInSeconds",
                    "idempotencyKey",
                }:
                    raise ValueError("unsupported request field")
                device_id = value.get("deviceId")
                slot_index = value.get("slotIndex")
                recipient = value.get("recipient")
                message_body = value.get("body")
                expires_in_seconds = value.get(
                    "expiresInSeconds",
                    DEFAULT_OUTBOUND_COMMAND_EXPIRES_SECONDS,
                )
                idempotency_key = value.get("idempotencyKey")
                if (
                    not isinstance(device_id, str)
                    or device_id not in self.app.devices
                    or not self.app.store.is_device_active(device_id)
                    or not isinstance(slot_index, int)
                    or isinstance(slot_index, bool)
                    or slot_index not in (0, 1)
                    or not isinstance(recipient, str)
                    or not 1 <= len(recipient.strip()) <= 64
                    or bool(re.search(r"[A-Za-z]", recipient))
                    or not isinstance(message_body, str)
                    or not 1 <= len(message_body) <= 2_000
                    or not isinstance(expires_in_seconds, int)
                    or isinstance(expires_in_seconds, bool)
                    or not MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS
                    <= expires_in_seconds
                    <= MAX_OUTBOUND_COMMAND_EXPIRES_SECONDS
                    or not isinstance(idempotency_key, str)
                    or not re.fullmatch(
                        r"[A-Za-z0-9._-]{16,128}",
                        idempotency_key,
                    )
                ):
                    raise ValueError("invalid outbound message")
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ):
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "invalid request"},
                )
                return
            if not self.require_api_device_access(
                client_id,
                device_id,
            ):
                return
            try:
                command = self.app.store.create_outbound_command(
                    device_id=device_id,
                    secret=self.app.devices[device_id],
                    slot_index=slot_index,
                    recipient=recipient.strip(),
                    body=message_body,
                    idempotency_key=idempotency_key,
                    now_ms=int(time.time() * 1000),
                    expires_in_seconds=expires_in_seconds,
                )
            except ValueError:
                self.send_json(
                    HTTPStatus.CONFLICT,
                    {"error": "idempotency conflict"},
                )
                return
            self.app.store.record_audit(
                client_id,
                "OUTBOUND_SMS_QUEUE",
                device_id,
                "SUCCESS",
                {
                    "slotIndex": slot_index,
                    "expiresInSeconds": expires_in_seconds,
                },
            )
            self.send_json(
                HTTPStatus.CREATED,
                {"outboundMessage": command},
            )
            return
        if path == "/v1/devices":
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
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
            if not self.require_api_device_access(
                client_id,
                device_id,
            ):
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
            self.app.store.record_audit(
                client_id,
                "DEVICE_CREATE",
                device_id,
                "SUCCESS",
            )
            self.send_json(HTTPStatus.CREATED, {"device": device})
            return
        if path == "/v1/pairings":
            if not self.app.accept_ingestion:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
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
                    or not self.app.store.is_device_active(device_id)
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
                if not self.require_api_device_access(
                    client_id,
                    device_id,
                ):
                    return
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
            self.app.store.record_audit(
                client_id,
                "PAIRING_CREATE",
                device_id,
                "SUCCESS",
                {"expiresInSeconds": expires_in_seconds},
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
            if (
                device_id is None
                or secret is None
                or not self.app.store.is_device_active(device_id)
            ):
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
                if set(value) - {
                    "deviceId",
                    "slotIndex",
                    "maxAgeSeconds",
                    "eventId",
                }:
                    raise ValueError("unsupported request field")
                device_id = value.get("deviceId")
                if device_id is not None and (
                    not isinstance(device_id, str)
                    or not re.fullmatch(
                        r"[A-Za-z0-9._-]{1,64}",
                        device_id,
                    )
                ):
                    raise ValueError("invalid deviceId")
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
                if event_id is None and device_id is None:
                    raise ValueError(
                        "deviceId is required for latest OTP claims"
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
            if (
                device_id is not None
                and not self.require_api_device_access(
                    client_id,
                    device_id,
                )
            ):
                return
            claimed = self.app.store.claim_latest_otp(
                self.api_device_secrets(client_id),
                client_id,
                int(time.time() * 1000),
                max_age_seconds,
                slot_index=slot_index,
                event_id=event_id,
                device_id=device_id,
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
            or not self.app.store.is_device_active(device_id)
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
            decrypted = decrypt_payload(envelope, device_id, secret)
            inserted = self.app.store.accept(
                device_id, idempotency_key, nonce, envelope, now_ms
            )
            if envelope["eventType"] == "OUTBOUND_SMS_STATUS":
                if not self.app.store.update_outbound_command_status(
                    device_id,
                    decrypted["payload"],
                    now_ms,
                ):
                    raise ValueError("unknown outbound command")
            elif envelope["eventType"] == "DEVICE_STATE":
                self.app.store.upsert_device_state(
                    device_id,
                    decrypted["payload"],
                    now_ms,
                )
            elif envelope["eventType"] == "INCOMING_SMS":
                self.app.store.observe_incoming_sms(
                    device_id,
                    decrypted["payload"],
                    now_ms,
                )
            self.app.store.touch_device(device_id, now_ms)
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
        group_match = re.fullmatch(
            r"/v1/device-groups/([A-Za-z0-9._-]{1,64})",
            path,
        )
        if group_match:
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            if self.api_allowed_device_ids(client_id) is not None:
                self.send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": "global device access required"},
                )
                return
            group_id = group_match.group(1)
            try:
                value = self.read_json_body(8_192)
                if not value or set(value) - {"name", "deviceIds"}:
                    raise ValueError("invalid request fields")
                name = value.get("name")
                device_ids = value.get("deviceIds")
                if name is not None and not isinstance(name, str):
                    raise ValueError("invalid name")
                if device_ids is not None and (
                    not isinstance(device_ids, list)
                    or not all(
                        isinstance(device_id, str)
                        and re.fullmatch(
                            r"[A-Za-z0-9._-]{1,64}",
                            device_id,
                        )
                        and self.api_can_access_device(
                            client_id,
                            device_id,
                        )
                        for device_id in device_ids
                    )
                ):
                    raise ValueError("invalid deviceIds")
                group = self.app.store.update_group(
                    group_id,
                    name,
                    device_ids,
                    int(time.time() * 1000),
                )
            except (
                TypeError,
                ValueError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ) as error:
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": str(error)},
                )
                return
            if group is None:
                self.send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": "device group not found"},
                )
                return
            self.app.store.record_audit(
                client_id,
                "DEVICE_GROUP_UPDATE",
                None,
                "SUCCESS",
                {"groupId": group_id},
            )
            self.send_json(HTTPStatus.OK, {"group": group})
            return
        # PUT /v1/devices/{device_id}
        if path.startswith("/v1/devices/"):
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            device_id = path[len("/v1/devices/"):]
            if not device_id or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid device_id"})
                return
            if not self.require_api_device_access(client_id, device_id):
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
            self.app.store.record_audit(
                client_id,
                "DEVICE_UPDATE",
                device_id,
                "SUCCESS",
                {
                    "descriptionChanged": description is not None,
                    "secretRotated": secret_base64 is not None,
                },
            )
            self.send_json(HTTPStatus.OK, {"device": device})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        group_match = re.fullmatch(
            r"/v1/device-groups/([A-Za-z0-9._-]{1,64})",
            path,
        )
        if group_match:
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            if self.api_allowed_device_ids(client_id) is not None:
                self.send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": "global device access required"},
                )
                return
            group_id = group_match.group(1)
            if not self.app.store.delete_group(group_id):
                self.send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": "device group not found"},
                )
                return
            self.app.store.record_audit(
                client_id,
                "DEVICE_GROUP_DELETE",
                None,
                "SUCCESS",
                {"groupId": group_id},
            )
            self.send_json(HTTPStatus.OK, {"deleted": True})
            return
        # DELETE /v1/devices/{device_id}
        if path.startswith("/v1/devices/"):
            client_id = self.authorize_api("pairing:create")
            if client_id is None:
                return
            device_id = path[len("/v1/devices/"):]
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", device_id):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid device_id"})
                return
            if not self.require_api_device_access(client_id, device_id):
                return
            retired = self.app.store.retire_device(
                device_id,
                int(time.time() * 1000),
            )
            if not retired:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "device not found"})
                return
            self.app.refresh_devices()
            self.app.store.record_audit(
                client_id,
                "DEVICE_RETIRE",
                device_id,
                "SUCCESS",
            )
            self.send_json(
                HTTPStatus.OK,
                {"retired": True, "device": self.app.store.get_device(device_id)},
            )
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
        allowed_device_ids = value.get("allowedDeviceIds")
        if not re.fullmatch(r"[0-9a-f]{64}", token_sha256):
            raise ValueError(f"Invalid API token hash for {client_id}")
        if not isinstance(scopes, list) or not all(
            isinstance(scope, str)
            and scope in {
                "messages:read",
                "messages:send",
                "otp:claim",
                "pairing:create",
                "*",
            }
            for scope in scopes
        ):
            raise ValueError(f"Invalid API scopes for {client_id}")
        if (
            allowed_device_ids is not None
            and (
                not isinstance(allowed_device_ids, list)
                or not allowed_device_ids
                or not all(
                    isinstance(device_id, str)
                    and re.fullmatch(
                        r"[A-Za-z0-9._-]{1,64}",
                        device_id,
                    )
                    for device_id in allowed_device_ids
                )
                or len(set(allowed_device_ids)) != len(allowed_device_ids)
            )
        ):
            raise ValueError(
                f"Invalid allowedDeviceIds for {client_id}"
            )
        clients[client_id] = {
            "token_sha256": token_sha256,
            "scopes": scopes,
            "allowed_device_ids": (
                list(allowed_device_ids)
                if allowed_device_ids is not None
                else None
            ),
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
