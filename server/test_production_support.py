import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from server.backup_database import backup_database
from server.gateway_server import GatewayStore
from server.restore_database import restore_database


class ProductionSetupTest(unittest.TestCase):
    def test_setup_writes_private_reusable_credentials_without_printing_them(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            command = [
                sys.executable,
                "server/setup_production.py",
                "--domain",
                "gateway.example.com",
                "--runtime-dir",
                str(runtime),
                "--env-file",
                str(Path(temporary) / ".env"),
            ]
            first = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
            )
            config = json.loads((runtime / "config.json").read_text())
            provisioning = json.loads(
                (runtime / "android-provisioning.json").read_text()
            )
            token = (runtime / "automation-api-token.txt").read_text().strip()
            secret = config["devices"]["xiaomi-gateway"]["secret_base64"]

            self.assertNotIn(secret, first.stdout)
            self.assertNotIn(token, first.stdout)
            self.assertEqual(
                hashlib.sha256(token.encode()).hexdigest(),
                config["api_clients"]["automation"]["token_sha256"],
            )
            self.assertEqual(
                secret, provisioning["sharedSecretBase64"]
            )
            self.assertEqual(
                "https://gateway.example.com", provisioning["endpoint"]
            )
            self.assertTrue(provisioning["enabled"])
            self.assertEqual(
                0o600, (runtime / "config.json").stat().st_mode & 0o777
            )
            self.assertEqual(
                0o600,
                (runtime / "android-provisioning.json").stat().st_mode
                & 0o777,
            )
            self.assertEqual([], list(runtime.glob(".*.tmp")))

            subprocess.run(command, check=True, capture_output=True, text=True)
            second = json.loads((runtime / "config.json").read_text())
            self.assertEqual(
                secret,
                second["devices"]["xiaomi-gateway"]["secret_base64"],
            )
            self.assertEqual(
                hashlib.sha256(token.encode()).hexdigest(),
                second["api_clients"]["automation"]["token_sha256"],
            )

            subprocess.run(
                command + ["--rotate-api-token", "--rotate-device-secret"],
                check=True,
                capture_output=True,
                text=True,
            )
            rotated = json.loads((runtime / "config.json").read_text())
            rotated_token = (
                runtime / "automation-api-token.txt"
            ).read_text().strip()
            self.assertNotEqual(
                secret,
                rotated["devices"]["xiaomi-gateway"]["secret_base64"],
            )
            self.assertNotEqual(token, rotated_token)
            self.assertEqual(
                hashlib.sha256(rotated_token.encode()).hexdigest(),
                rotated["api_clients"]["automation"]["token_sha256"],
            )

    def test_setup_rejects_non_hostname_domain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run(
                [
                    sys.executable,
                    "server/setup_production.py",
                    "--domain",
                    "192.0.2.1",
                    "--runtime-dir",
                    temporary,
                    "--env-file",
                    str(Path(temporary) / ".env"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("valid DNS hostname", result.stderr)


class DatabaseBackupTest(unittest.TestCase):
    def test_backup_is_consistent_and_retention_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "gateway.db"
            backups = root / "backups"
            store = GatewayStore(database)
            store.accept(
                "device",
                "key",
                "nonce",
                {
                    "schemaVersion": 2,
                    "deliveryId": "delivery",
                    "sourceEventId": "source",
                    "eventType": "LOCAL_SELF_TEST",
                    "createdAt": 1000,
                    "subscriptionId": None,
                    "slotIndex": None,
                    "payload": {
                        "algorithm": "AES-256-GCM",
                        "nonceBase64": "AAECAwQFBgcICQoL",
                        "ciphertextBase64": "ciphertext",
                    },
                },
                1000,
            )

            first = backup_database(database, backups, keep=1)
            second = backup_database(database, backups, keep=1)

            self.assertFalse(first.exists())
            self.assertTrue(second.exists())
            self.assertEqual(1, len(list(backups.glob("gateway-*.db"))))
            self.assertEqual([], list(backups.glob("*.partial")))
            with sqlite3.connect(second) as copied:
                self.assertEqual(
                    1, copied.execute("SELECT COUNT(*) FROM events").fetchone()[0]
                )
                self.assertEqual(
                    "ok", copied.execute("PRAGMA integrity_check").fetchone()[0]
                )

    def test_verified_backup_can_replace_a_changed_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "gateway.db"
            backups = root / "backups"
            store = GatewayStore(database)
            store.accept(
                "device",
                "original",
                "nonce-original",
                {
                    "schemaVersion": 2,
                    "deliveryId": "original",
                    "sourceEventId": "source",
                    "eventType": "LOCAL_SELF_TEST",
                    "createdAt": 1000,
                    "subscriptionId": None,
                    "slotIndex": None,
                    "payload": {
                        "algorithm": "AES-256-GCM",
                        "nonceBase64": "AAECAwQFBgcICQoL",
                        "ciphertextBase64": "ciphertext",
                    },
                },
                1000,
            )
            backup = backup_database(database, backups)
            store.accept(
                "device",
                "later",
                "nonce-later",
                {
                    "schemaVersion": 2,
                    "deliveryId": "later",
                    "sourceEventId": "source",
                    "eventType": "LOCAL_SELF_TEST",
                    "createdAt": 2000,
                    "subscriptionId": None,
                    "slotIndex": None,
                    "payload": {
                        "algorithm": "AES-256-GCM",
                        "nonceBase64": "AAECAwQFBgcICQoL",
                        "ciphertextBase64": "ciphertext",
                    },
                },
                2000,
            )

            restore_database(backup, database)

            with sqlite3.connect(database) as restored:
                self.assertEqual(
                    1,
                    restored.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                )
                self.assertEqual(
                    "original",
                    restored.execute(
                        "SELECT idempotency_key FROM events"
                    ).fetchone()[0],
                )


if __name__ == "__main__":
    unittest.main()
