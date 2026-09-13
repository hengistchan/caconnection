import base64
import json
import tempfile
import unittest
from pathlib import Path

from server.gateway_server import (
    GatewayStore,
    expected_signature,
    validate_envelope,
)


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
            "payload": {"type": "LOCAL_SELF_TEST"},
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


if __name__ == "__main__":
    unittest.main()
