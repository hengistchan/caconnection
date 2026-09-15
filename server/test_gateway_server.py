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
    extract_otp_candidates,
    expected_signature,
    validate_envelope,
)
from server.protocol_smoke import run_smoke
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

    def test_otp_candidates_prioritize_context_and_deduplicate(self) -> None:
        self.assertEqual(
            ["482913", "2026"],
            extract_otp_candidates(
                "Order 2026. Your verification code is 482913; "
                "repeat 482913."
            ),
        )
        self.assertEqual(
            ["739251"],
            extract_otp_candidates("您的验证码为739251，十分钟内有效。"),
        )

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
        invalid_type = dict(self.envelope)
        invalid_type["eventType"] = "UNSUPPORTED"
        with self.assertRaisesRegex(ValueError, "unsupported eventType"):
            validate_envelope(invalid_type)
        invalid_slot = dict(self.envelope)
        invalid_slot["slotIndex"] = 99
        with self.assertRaisesRegex(ValueError, "invalid slotIndex"):
            validate_envelope(invalid_slot)

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
        self.api_token = "test-api-token"
        self.store = GatewayStore(Path(self.temporary.name) / "gateway.db")
        self.server = GatewayHttpServer(
            ("127.0.0.1", 0),
            {"device": self.secret},
            self.store,
            api_clients={
                "automation": {
                    "token_sha256": __import__("hashlib").sha256(
                        self.api_token.encode()
                    ).hexdigest(),
                    "scopes": [
                        "messages:read",
                        "otp:claim",
                        "pairing:create",
                    ],
                },
                "readonly": {
                    "token_sha256": __import__("hashlib").sha256(
                        b"readonly-token"
                    ).hexdigest(),
                    "scopes": ["messages:read"],
                },
            },
            server_settings={
                "pairing_public_endpoint": "https://gateway.example.test",
                "pairing_certificate_pin_sha256_base64": base64.b64encode(
                    bytes(range(32))
                ).decode(),
            },
            pairing_token_factory=lambda: (
                "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
            ),
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

    def encrypted_body(
        self,
        *,
        event_type: str = "LOCAL_SELF_TEST",
        payload: Optional[dict] = None,
        slot_index: Optional[int] = None,
    ) -> bytes:
        envelope = {
            "schemaVersion": 1,
            "deliveryId": "delivery",
            "sourceEventId": "source",
            "eventType": event_type,
            "createdAt": 1000,
            "subscriptionId": 1 if slot_index is not None else None,
            "slotIndex": slot_index,
            "payload": payload or {
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

    def api_request(
        self,
        method: str,
        path: str,
        *,
        token: Optional[str] = None,
        value: Optional[dict] = None,
    ) -> tuple[int, dict]:
        context = ssl.create_default_context(cafile=str(self.certificate))
        connection = http.client.HTTPSConnection(
            "127.0.0.1",
            self.server.server_port,
            context=context,
            timeout=3,
        )
        body = (
            json.dumps(value, separators=(",", ":")).encode()
            if value is not None
            else None
        )
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=body, headers=headers)
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

    def test_health_readiness_and_version_endpoints(self) -> None:
        self.assertEqual(
            (200, {"status": "ok"}),
            self.api_request("GET", "/health"),
        )
        self.assertEqual(
            (200, {"status": "ready"}),
            self.api_request("GET", "/ready"),
        )
        status, version = self.api_request("GET", "/version")
        self.assertEqual(200, status)
        self.assertEqual("caconnection-gateway", version["service"])
        self.assertEqual("0.2.0", version["version"])
        self.assertEqual(1, version["apiVersion"])
        self.assertEqual(2, version["protocolSchemaVersion"])

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

    def test_authenticated_message_api_and_one_time_otp_claim(self) -> None:
        body = self.encrypted_body(
            event_type="INCOMING_SMS",
            slot_index=0,
            payload={
                "originatingAddress": "service",
                "body": "Your verification code is 482913.",
                "partCount": 1,
                "resolutionMethod": "OEM_SUBSCRIPTION_EXTRA",
                "resolutionConfidence": "HIGH",
            },
        )
        self.assertEqual(
            201,
            self.request(
                body=body,
                nonce="sms-nonce",
                idempotency_key="sms-key",
            )[0],
        )

        self.assertEqual(
            401, self.api_request("GET", "/v1/messages")[0]
        )
        status, messages = self.api_request(
            "GET",
            "/v1/messages?slotIndex=0&limit=10",
            token=self.api_token,
        )
        self.assertEqual(200, status)
        self.assertEqual(1, len(messages["messages"]))
        self.assertEqual(
            ["482913"], messages["messages"][0]["otpCandidates"]
        )
        message_id = messages["messages"][0]["id"]

        status, claimed = self.api_request(
            "POST",
            "/v1/otp/claim",
            token=self.api_token,
            value={
                "slotIndex": 0,
                "maxAgeSeconds": 3600,
                "eventId": message_id,
            },
        )
        self.assertEqual(200, status)
        self.assertEqual("482913", claimed["otp"]["code"])
        self.assertEqual(
            404,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token=self.api_token,
                value={
                    "slotIndex": 0,
                    "maxAgeSeconds": 3600,
                    "eventId": message_id,
                },
            )[0],
        )
        self.assertEqual(
            403,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token="readonly-token",
                value={"maxAgeSeconds": 3600},
            )[0],
        )
        raw = json.dumps(self.store.latest()[0]["envelope"])
        self.assertNotIn("482913", raw)

    def test_pairing_session_claim_is_one_time_and_returns_provisioning(self) -> None:
        status, created = self.api_request(
            "POST",
            "/v1/pairings",
            token=self.api_token,
            value={"deviceId": "device", "expiresInSeconds": 300},
        )

        self.assertEqual(201, status)
        pairing = created["pairing"]
        self.assertEqual("device", pairing["deviceId"])
        payload = json.loads(pairing["payload"])
        self.assertEqual("ca-connection-pairing", payload["type"])
        self.assertEqual(
            "https://gateway.example.test",
            payload["endpoint"],
        )
        self.assertNotIn("sharedSecret", pairing["payload"])

        status, claimed = self.api_request(
            "POST",
            "/v1/pairings/claim",
            value={"pairingToken": payload["pairingToken"]},
        )
        self.assertEqual(200, status)
        provisioning = claimed["provisioning"]
        self.assertEqual("device", provisioning["deviceId"])
        self.assertEqual(
            base64.b64encode(self.secret).decode(),
            provisioning["sharedSecretBase64"],
        )
        self.assertEqual(
            payload["certificatePinSha256Base64"],
            provisioning["certificatePinSha256Base64"],
        )
        self.assertEqual(
            (
                410,
                {"error": "pairing expired or already used"},
            ),
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": payload["pairingToken"]},
            ),
        )

    def test_new_pairing_invalidates_previous_code_for_same_device(self) -> None:
        tokens = iter(("a" * 43, "b" * 43))
        self.server.pairing_token_factory = lambda: next(tokens)

        first_status, first_created = self.api_request(
            "POST",
            "/v1/pairings",
            token=self.api_token,
            value={"deviceId": "device", "expiresInSeconds": 300},
        )
        second_status, second_created = self.api_request(
            "POST",
            "/v1/pairings",
            token=self.api_token,
            value={"deviceId": "device", "expiresInSeconds": 300},
        )
        self.assertEqual(201, first_status)
        self.assertEqual(201, second_status)

        first_token = json.loads(
            first_created["pairing"]["payload"]
        )["pairingToken"]
        second_token = json.loads(
            second_created["pairing"]["payload"]
        )["pairingToken"]
        self.assertEqual(
            (410, {"error": "pairing expired or already used"}),
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": first_token},
            ),
        )
        self.assertEqual(
            200,
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": second_token},
            )[0],
        )

    def test_pairing_create_requires_scope_and_valid_device(self) -> None:
        self.assertEqual(
            (200, {"devices": ["device"]}),
            self.api_request(
                "GET",
                "/v1/devices",
                token=self.api_token,
            ),
        )
        self.assertEqual(
            401,
            self.api_request(
                "POST",
                "/v1/pairings",
                value={"deviceId": "device"},
            )[0],
        )
        self.assertEqual(
            403,
            self.api_request(
                "POST",
                "/v1/pairings",
                token="readonly-token",
                value={"deviceId": "device"},
            )[0],
        )
        self.assertEqual(
            (
                400,
                {"error": "invalid request"},
            ),
            self.api_request(
                "POST",
                "/v1/pairings",
                token=self.api_token,
                value={"deviceId": "unknown"},
            ),
        )

    def test_pairing_invalid_expired_and_rate_limited_claims_are_generic(self) -> None:
        self.assertEqual(
            (400, {"error": "invalid request"}),
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": "too-short"},
            ),
        )
        expired_token = "z" * 43
        self.store.create_pairing(
            expired_token,
            "device",
            int(time.time() * 1000) - 120_000,
            60,
        )
        self.assertEqual(
            (410, {"error": "pairing expired or already used"}),
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": expired_token},
            ),
        )
        self.server.pairing_claim_requests_per_minute = 1
        self.server.rate_limiter = type(self.server.rate_limiter)()
        self.assertEqual(
            410,
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": "y" * 43},
            )[0],
        )
        self.assertEqual(
            429,
            self.api_request(
                "POST",
                "/v1/pairings/claim",
                value={"pairingToken": "x" * 43},
            )[0],
        )

    def test_exact_event_otp_claim_does_not_consume_another_message(self) -> None:
        for suffix, code in (("older", "112233"), ("newer", "778899")):
            body = self.encrypted_body(
                event_type="INCOMING_SMS",
                slot_index=0,
                payload={
                    "originatingAddress": "service",
                    "body": f"Verification code: {code}",
                    "partCount": 1,
                    "resolutionMethod": "OEM_SUBSCRIPTION_EXTRA",
                    "resolutionConfidence": "HIGH",
                },
            )
            self.assertEqual(
                201,
                self.request(
                    body=body,
                    nonce=f"exact-{suffix}",
                    idempotency_key=f"exact-{suffix}",
                )[0],
            )
        status, messages = self.api_request(
            "GET",
            "/v1/messages?slotIndex=0&limit=10",
            token=self.api_token,
        )
        self.assertEqual(200, status)
        older = next(
            message
            for message in messages["messages"]
            if message["otpCandidates"] == ["112233"]
        )
        newer = next(
            message
            for message in messages["messages"]
            if message["otpCandidates"] == ["778899"]
        )

        status, claimed = self.api_request(
            "POST",
            "/v1/otp/claim",
            token=self.api_token,
            value={
                "slotIndex": 0,
                "maxAgeSeconds": 3600,
                "eventId": older["id"],
            },
        )

        self.assertEqual(200, status)
        self.assertEqual(older["id"], claimed["otp"]["eventId"])
        self.assertEqual("112233", claimed["otp"]["code"])
        status, next_claim = self.api_request(
            "POST",
            "/v1/otp/claim",
            token=self.api_token,
            value={"slotIndex": 0, "maxAgeSeconds": 3600},
        )
        self.assertEqual(200, status)
        self.assertEqual(newer["id"], next_claim["otp"]["eventId"])
        self.assertEqual("778899", next_claim["otp"]["code"])

    def test_api_rate_limit_returns_retry_after(self) -> None:
        self.server.api_requests_per_minute = 1
        self.assertEqual(
            200,
            self.api_request(
                "GET", "/v1/messages", token=self.api_token
            )[0],
        )
        status, response = self.api_request(
            "GET", "/v1/messages", token=self.api_token
        )
        self.assertEqual(429, status)
        self.assertEqual({"error": "rate limit exceeded"}, response)

    def test_invalid_api_tokens_are_rate_limited_by_client_ip(self) -> None:
        self.server.api_auth_requests_per_minute = 1
        self.assertEqual(
            401,
            self.api_request(
                "GET",
                "/v1/messages",
                token="invalid-token-one",
            )[0],
        )
        self.assertEqual(
            429,
            self.api_request(
                "GET",
                "/v1/messages",
                token="invalid-token-two",
            )[0],
        )

    def test_authenticated_ingestion_is_rate_limited_per_device(self) -> None:
        self.server.device_requests_per_minute = 1
        self.assertEqual(
            201,
            self.request(
                nonce="device-rate-one",
                idempotency_key="device-rate-one",
            )[0],
        )
        self.assertEqual(
            429,
            self.request(
                nonce="device-rate-two",
                idempotency_key="device-rate-two",
            )[0],
        )

    def test_api_rejects_invalid_query_and_json_types(self) -> None:
        self.assertEqual(
            400,
            self.api_request(
                "GET",
                "/v1/messages?limit=0",
                token=self.api_token,
            )[0],
        )
        self.assertEqual(
            400,
            self.api_request(
                "GET",
                "/v1/messages?unknown=value",
                token=self.api_token,
            )[0],
        )
        self.assertEqual(
            400,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token=self.api_token,
                value={"slotIndex": True},
            )[0],
        )
        self.assertEqual(
            400,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token=self.api_token,
                value={"maxAgeSeconds": True},
            )[0],
        )
        self.assertEqual(
            400,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token=self.api_token,
                value={"eventId": True},
            )[0],
        )
        self.assertEqual(
            400,
            self.api_request(
                "POST",
                "/v1/otp/claim",
                token=self.api_token,
                value={"eventId": 0},
            )[0],
        )

    def test_signed_protocol_smoke_supports_separate_connect_host(self) -> None:
        config = Path(self.temporary.name) / "smoke-config.json"
        config.write_text(
            json.dumps(
                {
                    "devices": {
                        "device": {
                            "secret_base64": base64.b64encode(
                                self.secret
                            ).decode()
                        }
                    }
                }
            ),
            encoding="utf-8",
        )

        status = run_smoke(
            f"https://localhost:{self.server.server_port}",
            config,
            device_id="device",
            connect_host="127.0.0.1",
            ca_file=self.certificate,
        )

        self.assertEqual(201, status)
        self.assertEqual("LOCAL_SELF_TEST", self.store.latest()[0]["event_type"])

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
