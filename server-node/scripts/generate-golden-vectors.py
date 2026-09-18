#!/usr/bin/env python3
"""
Generate golden test vectors for cross-language compatibility testing.

Run from the project root:
    python3 server-node/scripts/generate-golden-vectors.py > server-node/test/fixtures/golden-vectors.json
"""

import base64
import hashlib
import hmac
import json
import os
import sys

# Add server directory to path so we can import gateway_server
# Script is at server-node/scripts/, server is at server/
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_project_root, 'server'))
from gateway_server import (
    payload_key,
    encrypt_payload,
    decrypt_payload,
    expected_signature,
    extract_otp_candidates,
    canonical_request,
)

def generate_vectors():
    vectors = {}

    # Test secrets (32 bytes each)
    vectors["secrets"] = {
        "device-a": base64.b64encode(os.urandom(32)).decode("ascii"),
        "device-b": base64.b64encode(os.urandom(32)).decode("ascii"),
    }

    # HKDF key derivation vectors
    hkdf_vectors = []
    for device_id, secret_b64 in vectors["secrets"].items():
        secret = base64.b64decode(secret_b64)
        key = payload_key(secret, device_id)
        hkdf_vectors.append({
            "secretBase64": secret_b64,
            "deviceId": device_id,
            "derivedKeyBase64": base64.b64encode(key).decode("ascii"),
        })
    vectors["hkdf"] = hkdf_vectors

    # Encryption vectors
    encryption_vectors = []
    test_payloads = [
        {
            "originatingAddress": "+1234567890",
            "body": "Your OTP is 123456",
            "partCount": 1,
        },
        {
            "eventType": "POSTED",
            "sourcePackage": "com.example.app",
            "title": "Test Notification",
            "body": "Hello World",
        },
    ]

    for device_id, secret_b64 in vectors["secrets"].items():
        secret = base64.b64decode(secret_b64)
        for i, payload in enumerate(test_payloads):
            envelope = {
                "schemaVersion": 1,
                "deliveryId": f"delivery-{i}",
                "sourceEventId": f"source-{i}",
                "eventType": "INCOMING_SMS" if i == 0 else "NOTIFICATION",
                "createdAt": 1700000000000 + i * 1000,
                "subscriptionId": i,
                "slotIndex": i % 2,
                "payload": payload,
            }
            encrypted = encrypt_payload(envelope, device_id, secret)
            decrypted = decrypt_payload(encrypted, device_id, secret)

            encryption_vectors.append({
                "deviceId": device_id,
                "secretBase64": secret_b64,
                "plaintextEnvelope": envelope,
                "encryptedEnvelope": encrypted,
                "decryptedPayload": decrypted["payload"],
            })
    vectors["encryption"] = encryption_vectors

    # Signature vectors
    signature_vectors = []
    test_body = json.dumps({"test": "data"}, separators=(",", ":")).encode("utf-8")
    for device_id, secret_b64 in vectors["secrets"].items():
        secret = base64.b64decode(secret_b64)
        timestamp_ms = 1700000000000
        nonce = "test-nonce-abc123"
        idempotency_key = "test-key-xyz789"

        sig = expected_signature(secret, timestamp_ms, nonce, device_id, idempotency_key, test_body)
        canonical = canonical_request(timestamp_ms, nonce, device_id, idempotency_key, test_body)

        signature_vectors.append({
            "secretBase64": secret_b64,
            "timestampMs": timestamp_ms,
            "nonce": nonce,
            "deviceId": device_id,
            "idempotencyKey": idempotency_key,
            "bodyBase64": base64.b64encode(test_body).decode("ascii"),
            "canonicalRequest": canonical.decode("utf-8"),
            "signature": sig,
        })
    vectors["signatures"] = signature_vectors

    # OTP extraction vectors
    otp_vectors = [
        {"body": "Your verification code is 123456", "expected": ["123456"]},
        {"body": "OTP: 1234", "expected": ["1234"]},
        {"body": "验证码是888888", "expected": ["888888"]},
        {"body": "111111.\nverification code 222222", "expected": ["222222", "111111"]},
        {"body": "No OTP here", "expected": []},
        {"body": "123", "expected": []},  # Too short
        {"body": "123456789", "expected": []},  # Too long
        {"body": "Code 123456 and 123456", "expected": ["123456"]},  # Dedup
    ]
    vectors["otp"] = otp_vectors

    return vectors


if __name__ == "__main__":
    vectors = generate_vectors()
    print(json.dumps(vectors, indent=2, ensure_ascii=False))
