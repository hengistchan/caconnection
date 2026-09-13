import base64
import copy
import http.client
import json
import ssl
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Optional

from server.gateway_server import (
    GatewayHttpServer,
    GatewayStore,
    decrypt_payload,
    encrypt_payload,
    expected_signature,
    validate_envelope,
)
from server.setup_local import ensure_certificate


class GatewayServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.store = GatewayStore(Path(self.temporary.name) / "gateway.db")
        self.envelope = {
            "schemaVersion": 1,
            "deliveryId": "delivery-1",
            "sourceEventId": "source-1",
            "eventType": "LOCAL_SELF_TEST",
            "createdAt": 1000,
            "subscriptionId": None,
            "slotIndex": None,
            "payload": {
                "type": "LOCAL_SELF_TEST",
                "secretMarker": "payload-plaintext-must-not-appear",
            },
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_signature_is_stable_and_body_sensitive(self) -> None:
        secret = b"x" * 32
        body = json.dumps(self.envelope).encode()
        first = expected_signature(
            secret, 1000, "nonce", "device", "key", body
        )
        second = expected_signature(
            secret, 1000, "nonce", "device", "key", body
        )
        changed = expected_signature(
            secret, 1000, "nonce", "device", "key", body + b" "
        )
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertEqual(32, len(base64.b64decode(first)))

    def test_store_is_idempotent_with_fresh_nonces(self) -> None:
        self.assertTrue(
            self.store.accept("device", "key", "nonce-1", self.envelope, 1000)
        )
        self.assertFalse(
            self.store.accept("device", "key", "nonce-2", self.envelope, 1001)
        )
        self.assertEqual(1, len(self.store.latest()))

    def test_replayed_nonce_is_rejected(self) -> None:
        self.store.accept("device", "key-1", "nonce", self.envelope, 1000)
        with self.assertRaisesRegex(ValueError, "replayed nonce"):
            self.store.accept("device", "key-2", "nonce", self.envelope, 1001)

    def test_envelope_validation_rejects_missing_or_future_schema(self) -> None:
        self.assertEqual(self.envelope, validate_envelope(self.envelope))
        missing = dict(self.envelope)
        missing.pop("payload")
        with self.assertRaisesRegex(ValueError, "missing"):
            validate_envelope(missing)
        future = dict(self.envelope)
        future["schemaVersion"] = 2
        with self.assertRaisesRegex(ValueError, "unsupported"):
            validate_envelope(future)

    def test_payload_encryption_round_trip_hides_plaintext(self) -> None:
        secret = b"x" * 32
        encrypted = encrypt_payload(self.envelope, "device", secret)
        serialized = json.dumps(encrypted)

        self.assertEqual(2, encrypted["schemaVersion"])
        self.assertNotIn("payload-plaintext-must-not-appear", serialized)
        decrypted = decrypt_payload(encrypted, "device", secret)
        self.assertEqual(self.envelope["payload"], decrypted["payload"])

    def test_tampered_ciphertext_is_rejected_without_crypto_details(self) -> None:
        secret = b"x" * 32
        encrypted = encrypt_payload(self.envelope, "device", secret)
        tampered = copy.deepcopy(encrypted)
        ciphertext = bytearray(
            base64.b64decode(tampered["payload"]["ciphertextBase64"])
        )
        ciphertext[0] ^= 1
        tampered["payload"]["ciphertextBase64"] = base64.b64encode(
            ciphertext
        ).decode()

        with self.assertRaisesRegex(ValueError, "^invalid encrypted payload$"):
            decrypt_payload(tampered, "device", secret)

    def test_protocol_v2_golden_vector_matches_android(self) -> None:
        body = (
            '{"schemaVersion":2,"deliveryId":"delivery-1",'
            '"sourceEventId":"source-1","eventType":"INCOMING_SMS",'
            '"createdAt":1000,"subscriptionId":1,"slotIndex":0,'
            '"payload":{"algorithm":"AES-256-GCM",'
            '"nonceBase64":"AAECAwQFBgcICQoL",'
            '"ciphertextBase64":'
            '"ywDPVPnJ7ZnrQg0WeKUL+gbZJr9dU/ukYrcqhlatcR0\\u003d"}}'
        ).encode()
        envelope = validate_envelope(json.loads(body))
        decrypted = decrypt_payload(
            envelope, "xiaomi-gateway", bytes(range(32))
        )

        self.assertEqual({"body": "hello"}, decrypted["payload"])
        self.assertEqual(
            "661ZLTQKHvSSY69ZECEII/K9rb8xmnX50hJ9jCq5Klc=",
            expected_signature(
                bytes(range(32)),
                123_456,
                "nonce-1",
                "xiaomi-gateway",
                "sms-key",
                body,
            ),
        )

    def test_legacy_database_payload_is_migrated_to_ciphertext(self) -> None:
        self.store.accept("device", "key", "nonce", self.envelope, 1000)

        self.assertEqual(1, self.store.migrate_legacy_payloads({"device": b"x" * 32}))
        row = self.store.latest()[0]
        self.assertEqual(2, row["envelope"]["schemaVersion"])
        self.assertNotIn(
            "payload-plaintext-must-not-appear", json.dumps(row["envelope"])
        )
        self.assertEqual(
            self.envelope["payload"],
            decrypt_payload(row["envelope"], "device", b"x" * 32)["payload"],
        )
        self.assertEqual(
            0, self.store.migrate_legacy_payloads({"device": b"x" * 32})
        )


class GatewayHttpsIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.certificate_files = tempfile.TemporaryDirectory()
        root = Path(cls.certificate_files.name)
        cls.certificate, cls.private_key, _ = ensure_certificate(
            root / "trusted", "127.0.0.1"
        )
        cls.wrong_certificate, _, _ = ensure_certificate(
            root / "wrong", "127.0.0.1"
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.certificate_files.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.secret = bytes(range(32))
        self.store = GatewayStore(Path(self.temporary.name) / "gateway.db")
        self.server = GatewayHttpServer(
            ("127.0.0.1", 0),
            {"device": self.secret},
            self.store,
        )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(self.certificate, self.private_key)
        self.server.socket = context.wrap_socket(
            self.server.socket, server_side=True
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def encrypted_body(self) -> bytes:
        envelope = {
            "schemaVersion": 1,
            "deliveryId": "delivery",
            "sourceEventId": "source",
            "eventType": "LOCAL_SELF_TEST",
            "createdAt": 1000,
            "subscriptionId": None,
            "slotIndex": None,
            "payload": {
                "type": "LOCAL_SELF_TEST",
                "secretMarker": "integration-plaintext-marker",
            },
        }
        return json.dumps(
            encrypt_payload(envelope, "device", self.secret),
            separators=(",", ":"),
        ).encode()

    def request(
        self,
        *,
        body: Optional[bytes] = None,
        nonce: str = "nonce",
        idempotency_key: str = "key",
        timestamp_ms: Optional[int] = None,
        signature: Optional[str] = None,
    ) -> tuple[int, dict]:
        body = body or self.encrypted_body()
        timestamp_ms = timestamp_ms or int(time.time() * 1000)
        signature = signature or expected_signature(
            self.secret,
            timestamp_ms,
            nonce,
            "device",
            idempotency_key,
            body,
        )
        context = ssl.create_default_context(cafile=str(self.certificate))
        connection = http.client.HTTPSConnection(
            "127.0.0.1",
            self.server.server_port,
            context=context,
            timeout=3,
        )
        try:
            connection.request(
                "POST",
                "/v1/events",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Gateway-Device": "device",
                    "X-Gateway-Timestamp": str(timestamp_ms),
                    "X-Gateway-Nonce": nonce,
                    "X-Gateway-Signature": signature,
                    "Idempotency-Key": idempotency_key,
                },
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_valid_encrypted_request_is_stored_as_ciphertext(self) -> None:
        status, response = self.request()

        self.assertEqual(201, status)
        self.assertEqual({"accepted": True, "duplicate": False}, response)
        row = self.store.latest()[0]
        serialized = json.dumps(row["envelope"])
        self.assertNotIn("integration-plaintext-marker", serialized)
        self.assertEqual(2, row["envelope"]["schemaVersion"])

    def test_authentication_timestamp_replay_and_idempotency(self) -> None:
        body = self.encrypted_body()
        self.assertEqual(201, self.request(body=body)[0])
        self.assertEqual(
            409,
            self.request(
                body=body,
                nonce="nonce",
                idempotency_key="different-key",
            )[0],
        )
        self.assertEqual(
            200,
            self.request(body=body, nonce="fresh-nonce")[0],
        )
        self.assertEqual(1, len(self.store.latest()))
        self.assertEqual(
            401,
            self.request(
                body=body,
                nonce="bad-signature",
                idempotency_key="bad-signature",
                signature="not-a-valid-signature",
            )[0],
        )
        self.assertEqual(
            401,
            self.request(
                body=body,
                nonce="expired",
                idempotency_key="expired",
                timestamp_ms=int(time.time() * 1000) - 600_000,
            )[0],
        )

    def test_tampered_ciphertext_returns_generic_bad_request(self) -> None:
        envelope = json.loads(self.encrypted_body())
        ciphertext = bytearray(
            base64.b64decode(envelope["payload"]["ciphertextBase64"])
        )
        ciphertext[-1] ^= 1
        envelope["payload"]["ciphertextBase64"] = base64.b64encode(
            ciphertext
        ).decode()
        body = json.dumps(envelope, separators=(",", ":")).encode()

        status, response = self.request(
            body=body,
            nonce="tampered",
            idempotency_key="tampered",
        )

        self.assertEqual(400, status)
        self.assertEqual({"error": "invalid encrypted payload"}, response)
        self.assertEqual([], self.store.latest())

    def test_legacy_plaintext_ingestion_is_rejected(self) -> None:
        body = json.dumps(
            {
                "schemaVersion": 1,
                "deliveryId": "legacy",
                "sourceEventId": "legacy",
                "eventType": "LOCAL_SELF_TEST",
                "createdAt": 1000,
                "subscriptionId": None,
                "slotIndex": None,
                "payload": {"secretMarker": "must-not-store"},
            },
            separators=(",", ":"),
        ).encode()

        status, response = self.request(
            body=body,
            nonce="legacy",
            idempotency_key="legacy",
        )

        self.assertEqual(400, status)
        self.assertEqual(
            {"error": "encrypted schemaVersion 2 required"}, response
        )
        self.assertEqual([], self.store.latest())

    def test_untrusted_certificate_is_rejected(self) -> None:
        context = ssl.create_default_context(
            cafile=str(self.wrong_certificate)
        )
        connection = http.client.HTTPSConnection(
            "127.0.0.1",
            self.server.server_port,
            context=context,
            timeout=3,
        )
        with self.assertRaises(ssl.SSLCertVerificationError):
            connection.request("GET", "/health")
        connection.close()


if __name__ == "__main__":
    unittest.main()
