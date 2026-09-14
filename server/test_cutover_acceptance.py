import tempfile
import unittest
from pathlib import Path

from server.cutover_acceptance import (
    capture_baseline,
    read_private_token,
    validate_endpoint,
    verify_slot,
)


class CutoverAcceptanceTest(unittest.TestCase):
    def test_capture_baseline_records_only_latest_ids(self) -> None:
        def request(
            _endpoint,
            _method,
            path,
            _token,
            _value,
            _ca_file,
            _connect_host,
        ):
            if "slotIndex=0" in path:
                return 200, {"messages": [{"id": 12, "body": "not retained"}]}
            return 200, {"messages": []}

        baseline = capture_baseline(
            "https://gateway.example.com",
            "A" * 43,
            request=request,
        )

        self.assertEqual({"0": 12, "1": 0}, baseline["slots"])
        self.assertNotIn("body", baseline)

    def test_verify_exact_claim_is_redacted_and_rejects_second_claim(self) -> None:
        requests = []

        def request(
            _endpoint,
            method,
            path,
            _token,
            value,
            _ca_file,
            _connect_host,
        ):
            requests.append((method, path, value))
            if method == "GET":
                return 200, {
                    "messages": [
                        {
                            "id": 22,
                            "slotIndex": 0,
                            "receivedAt": 1234,
                            "body": "Verification code: 654321",
                            "sender": "private",
                            "otpCandidates": ["654321"],
                        }
                    ]
                }
            claim_count = sum(
                item[0] == "POST" for item in requests
            )
            if claim_count == 1:
                return 200, {
                    "otp": {
                        "eventId": 22,
                        "slotIndex": 0,
                        "code": "654321",
                    }
                }
            return 404, {"error": "no unclaimed OTP found"}

        result = verify_slot(
            "https://gateway.example.com",
            "A" * 43,
            {
                "schemaVersion": 1,
                "endpoint": "https://gateway.example.com",
                "slots": {"0": 20, "1": 10},
            },
            0,
            request=request,
        )

        self.assertEqual(
            {
                "slotIndex": 0,
                "eventId": 22,
                "receivedAt": 1234,
                "candidateCount": 1,
                "secondClaimStatus": 404,
            },
            result,
        )
        self.assertNotIn("654321", repr(result))
        self.assertEqual(22, requests[1][2]["eventId"])
        self.assertEqual(requests[1][2], requests[2][2])

    def test_verify_requires_a_new_otp_for_the_selected_slot(self) -> None:
        def request(*_args):
            return 200, {
                "messages": [
                    {
                        "id": 30,
                        "slotIndex": 1,
                        "otpCandidates": ["123456"],
                    }
                ]
            }

        with self.assertRaisesRegex(RuntimeError, "no new OTP-bearing"):
            verify_slot(
                "https://gateway.example.com",
                "A" * 43,
                {
                    "schemaVersion": 1,
                    "endpoint": "https://gateway.example.com",
                    "slots": {"0": 20, "1": 10},
                },
                0,
                request=request,
            )

    def test_private_token_and_endpoint_validation(self) -> None:
        self.assertEqual(
            "https://gateway.example.com",
            validate_endpoint("https://gateway.example.com/"),
        )
        with self.assertRaises(ValueError):
            validate_endpoint("http://gateway.example.com")
        with tempfile.TemporaryDirectory() as temporary:
            token_file = Path(temporary) / "token"
            token_file.write_text("A" * 43 + "\n")
            token_file.chmod(0o600)
            self.assertEqual("A" * 43, read_private_token(token_file))
            token_file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "group/world"):
                read_private_token(token_file)


if __name__ == "__main__":
    unittest.main()
