#!/usr/bin/env python3

"""Tests for the admin UI setup script."""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from setup_admin import (
    ADMIN_CLIENT_ID,
    ADMIN_SCOPES,
    generate_recovery_codes,
    generate_scrypt_hash,
    generate_totp_secret,
    recovery_code_hash,
    setup_admin_credentials,
    write_private_file,
)


class TestGenerateScryptHash(unittest.TestCase):
    """Test scrypt hash generation."""

    def test_hash_format(self):
        """Hash should be in algorithm:salt:key or salt:key format."""
        hash_value = generate_scrypt_hash("testpassword")
        parts = hash_value.split(":")
        # Can be 2 parts (legacy salt:key) or 3 parts (algorithm:salt:key)
        self.assertIn(len(parts), [2, 3])
        if len(parts) == 3:
            self.assertIn(parts[0], ['scrypt', 'pbkdf2'])  # algorithm
            self.assertTrue(len(parts[1]) > 0)  # salt
            self.assertTrue(len(parts[2]) > 0)  # key
        else:
            self.assertTrue(len(parts[0]) > 0)  # salt
            self.assertTrue(len(parts[1]) > 0)  # key

    def test_hash_deterministic(self):
        """Same password should produce different hashes (random salt)."""
        hash1 = generate_scrypt_hash("testpassword")
        hash2 = generate_scrypt_hash("testpassword")
        self.assertNotEqual(hash1, hash2)

    def test_different_passwords_different_hashes(self):
        """Different passwords should produce different hashes."""
        hash1 = generate_scrypt_hash("password1")
        hash2 = generate_scrypt_hash("password2")
        self.assertNotEqual(hash1, hash2)


class TestWritePrivateFile(unittest.TestCase):
    """Test private file writing."""

    def test_creates_file_with_permissions(self):
        """File should be created with 0600 permissions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.txt"
            write_private_file(path, "secret content")

            self.assertTrue(path.exists())
            stat = path.stat()
            # Check permissions (mask out file type bits)
            self.assertEqual(stat.st_mode & 0o777, 0o600)
            self.assertEqual(path.read_text(), "secret content")

    def test_creates_parent_directories(self):
        """Should create parent directories if needed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "subdir" / "test.txt"
            write_private_file(path, "content")

            self.assertTrue(path.exists())
            self.assertEqual(path.read_text(), "content")

    def test_overwrites_existing_file(self):
        """Should overwrite existing file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "test.txt"
            write_private_file(path, "original")
            write_private_file(path, "updated")

            self.assertEqual(path.read_text(), "updated")


class TestTotpCredentials(unittest.TestCase):
    def test_generates_standard_secret_and_hashed_recovery_codes(self):
        secret = generate_totp_secret()
        codes = generate_recovery_codes(3)
        self.assertRegex(secret, r"^[A-Z2-7]{32}$")
        self.assertEqual(len(codes), 3)
        self.assertEqual(len(set(codes)), 3)
        self.assertTrue(all(len(code) == 20 for code in codes))
        self.assertRegex(recovery_code_hash(codes[0]), r"^[0-9a-f]{64}$")


class TestSetupAdminCredentials(unittest.TestCase):
    """Test admin credential setup."""

    def _create_valid_config(self, runtime_dir: Path) -> None:
        """Create a valid Gateway config.json for testing."""
        runtime_dir.mkdir(parents=True, exist_ok=True)
        config = {
            "devices": {
                "test-device": {
                    "secret_base64": "dGVzdHNlY3JldDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz"
                }
            },
            "api_clients": {
                "automation": {
                    "token_sha256": "a" * 64,
                    "scopes": ["messages:read", "otp:claim"]
                }
            },
            "server": {
                "retention_days": 30,
                "otp_max_age_seconds": 600
            }
        }
        (runtime_dir / "config.json").write_text(
            json.dumps(config, indent=2) + "\n"
        )

    def test_requires_existing_config(self):
        """Should fail if config.json doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            runtime_dir.mkdir(parents=True, exist_ok=True)

            with self.assertRaises(SystemExit):
                setup_admin_credentials(runtime_dir)

    def test_requires_valid_config(self):
        """Should fail if config.json is missing required sections."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            runtime_dir.mkdir(parents=True, exist_ok=True)

            # Create invalid config (missing devices)
            config = {"api_clients": {}, "server": {}}
            (runtime_dir / "config.json").write_text(json.dumps(config))

            with self.assertRaises(SystemExit):
                setup_admin_credentials(runtime_dir)

    def test_first_run_creates_all_files(self):
        """First run should create all required files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)

            # Check all files exist
            self.assertTrue((runtime_dir / "config.json").exists())
            self.assertTrue((runtime_dir / "admin-config.json").exists())
            self.assertTrue((runtime_dir / "admin-ui-api-token.txt").exists())
            self.assertTrue((runtime_dir / "admin-ui-password.txt").exists())
            self.assertTrue((runtime_dir / "admin-ui-password-hash.txt").exists())
            self.assertTrue((runtime_dir / "admin-ui-session-secret.txt").exists())
            self.assertTrue((runtime_dir / "admin-ui-totp-secret.txt").exists())
            self.assertTrue(
                (runtime_dir / "admin-totp-state" / "totp-state.json").exists()
            )
            self.assertTrue(
                (runtime_dir / "admin-totp-state" / "session-state.json").exists()
            )
            self.assertEqual(
                (runtime_dir / "admin-ui-totp-secret.txt").read_text(),
                "\n",
            )

    def test_gateway_config_contains_token_hash(self):
        """Gateway config should contain only the token hash, not the token."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)

            # Read gateway config
            config = json.loads((runtime_dir / "config.json").read_text())

            # Check admin client exists
            self.assertIn(ADMIN_CLIENT_ID, config["api_clients"])
            client = config["api_clients"][ADMIN_CLIENT_ID]

            # Check token hash format
            self.assertIn("token_sha256", client)
            self.assertTrue(
                len(client["token_sha256"]) == 64  # SHA-256 hex
            )

            # Check scopes
            self.assertEqual(client["scopes"], ADMIN_SCOPES)

    def test_repeat_run_upgrades_admin_pairing_scope(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)
            config_path = runtime_dir / "config.json"
            config = json.loads(config_path.read_text())
            config["api_clients"][ADMIN_CLIENT_ID]["scopes"] = [
                "messages:read",
                "otp:claim",
            ]
            config_path.write_text(json.dumps(config))

            setup_admin_credentials(runtime_dir)

            upgraded = json.loads(config_path.read_text())
            self.assertEqual(
                ADMIN_SCOPES,
                upgraded["api_clients"][ADMIN_CLIENT_ID]["scopes"],
            )

    def test_api_token_not_in_gateway_config(self):
        """API token plaintext should NOT be in gateway config."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)

            # Read API token
            token = (runtime_dir / "admin-ui-api-token.txt").read_text().strip()

            # Read gateway config
            config_text = (runtime_dir / "config.json").read_text()

            # Token should not appear in config
            self.assertNotIn(token, config_text)

    def test_password_not_stored_in_plaintext(self):
        """Password hash should be stored, not plaintext password."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)

            # Read password file
            password = (runtime_dir / "admin-ui-password.txt").read_text().strip()

            # Read admin config
            admin_config = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )

            # Password hash should not be the password itself
            self.assertNotEqual(admin_config["password_hash"], password)

            # Hash should be in valid format (algorithm:salt:key or salt:key)
            parts = admin_config["password_hash"].split(":")
            self.assertIn(len(parts), [2, 3])

    def test_repeat_run_preserves_credentials(self):
        """Repeat run without rotation flags should preserve existing credentials."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # First run
            setup_admin_credentials(runtime_dir)
            token1 = (runtime_dir / "admin-ui-api-token.txt").read_text()
            password1 = (runtime_dir / "admin-ui-password.txt").read_text()
            session_state_path = (
                runtime_dir / "admin-totp-state" / "session-state.json"
            )
            session_state1 = json.loads(session_state_path.read_text())

            # Second run (no rotation)
            setup_admin_credentials(runtime_dir)
            token2 = (runtime_dir / "admin-ui-api-token.txt").read_text()
            password2 = (runtime_dir / "admin-ui-password.txt").read_text()
            session_state2 = json.loads(session_state_path.read_text())

            # Credentials should be preserved
            self.assertEqual(token1, token2)
            self.assertEqual(password1, password2)
            self.assertEqual(session_state1, session_state2)

    def test_rejects_malformed_session_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)
            session_state_path = (
                runtime_dir / "admin-totp-state" / "session-state.json"
            )
            session_state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "generation": 1,
                        "revokedSessions": {"invalid-session-id": -1},
                    }
                )
            )

            with self.assertRaises(SystemExit):
                setup_admin_credentials(runtime_dir)

    def test_rotate_api_token(self):
        """API token rotation should change the token."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # First run
            setup_admin_credentials(runtime_dir)
            token1 = (runtime_dir / "admin-ui-api-token.txt").read_text()
            config1 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )

            # Rotate token
            setup_admin_credentials(runtime_dir, rotate_api_token=True)
            token2 = (runtime_dir / "admin-ui-api-token.txt").read_text()
            config2 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )

            # Token should change
            self.assertNotEqual(token1, token2)
            # Password should be preserved
            self.assertEqual(
                config1["password_hash"],
                config2["password_hash"],
            )

    def test_rotate_password(self):
        """Password rotation should change the password."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # First run
            setup_admin_credentials(runtime_dir)
            password1 = (runtime_dir / "admin-ui-password.txt").read_text()
            config1 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )
            session_state_path = (
                runtime_dir / "admin-totp-state" / "session-state.json"
            )
            session_state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "generation": 4,
                        "revokedSessions": {"a" * 64: 9_999_999_999_999},
                    }
                )
            )

            # Rotate password
            setup_admin_credentials(runtime_dir, rotate_password=True)
            password2 = (runtime_dir / "admin-ui-password.txt").read_text()
            config2 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )
            session_state = json.loads(session_state_path.read_text())

            # Password should change
            self.assertNotEqual(password1, password2)
            # Session secret should be preserved
            self.assertEqual(
                config1.get("session_secret"),
                config2.get("session_secret"),
            )
            self.assertEqual(session_state["generation"], 5)
            self.assertEqual(session_state["revokedSessions"], {})

    def test_rotate_session_secret(self):
        """Session secret rotation should change the secret."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # First run
            setup_admin_credentials(runtime_dir)
            config1 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )
            session_state_path = (
                runtime_dir / "admin-totp-state" / "session-state.json"
            )
            session_state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "generation": 7,
                        "revokedSessions": {"b" * 64: 9_999_999_999_999},
                    }
                )
            )

            # Rotate session secret
            setup_admin_credentials(runtime_dir, rotate_session_secret=True)
            config2 = json.loads(
                (runtime_dir / "admin-config.json").read_text()
            )
            session_state = json.loads(session_state_path.read_text())

            # Session secret should change
            self.assertNotEqual(
                config1["session_secret"],
                config2["session_secret"],
            )
            self.assertEqual(session_state["generation"], 8)
            self.assertEqual(session_state["revokedSessions"], {})

    def test_enable_rotate_and_disable_totp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            setup_admin_credentials(runtime_dir, enable_totp=True)
            secret1 = (
                runtime_dir / "admin-ui-totp-secret.txt"
            ).read_text().strip()
            state1 = json.loads(
                (
                    runtime_dir / "admin-totp-state" / "totp-state.json"
                ).read_text()
            )
            recovery1 = (
                runtime_dir / "admin-ui-totp-recovery-codes.txt"
            ).read_text().splitlines()
            uri1 = (runtime_dir / "admin-ui-totp-uri.txt").read_text()
            self.assertRegex(secret1, r"^[A-Z2-7]{32}$")
            self.assertEqual(len(recovery1), 10)
            self.assertEqual(len(state1["recoveryCodeHashes"]), 10)
            self.assertNotIn(recovery1[0], json.dumps(state1))
            self.assertIn(secret1, uri1)

            setup_admin_credentials(runtime_dir)
            self.assertEqual(
                secret1,
                (runtime_dir / "admin-ui-totp-secret.txt").read_text().strip(),
            )

            setup_admin_credentials(runtime_dir, rotate_totp=True)
            secret2 = (
                runtime_dir / "admin-ui-totp-secret.txt"
            ).read_text().strip()
            self.assertNotEqual(secret1, secret2)

            setup_admin_credentials(runtime_dir, disable_totp=True)
            self.assertEqual(
                (runtime_dir / "admin-ui-totp-secret.txt").read_text(),
                "\n",
            )
            disabled_state = json.loads(
                (
                    runtime_dir / "admin-totp-state" / "totp-state.json"
                ).read_text()
            )
            self.assertEqual(disabled_state["recoveryCodeHashes"], [])
            self.assertFalse(
                (runtime_dir / "admin-ui-totp-recovery-codes.txt").exists()
            )
            self.assertFalse((runtime_dir / "admin-ui-totp-uri.txt").exists())

    def test_no_credentials_in_stdout(self):
        """No credentials should be printed to stdout."""
        with tempfile.TemporaryDirectory() as tmpdir:
            import io
            import contextlib

            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            stdout_capture = io.StringIO()
            with contextlib.redirect_stdout(stdout_capture):
                setup_admin_credentials(runtime_dir)

            output = stdout_capture.getvalue()

            # Read credentials
            token = (runtime_dir / "admin-ui-api-token.txt").read_text().strip()
            password = (runtime_dir / "admin-ui-password.txt").read_text().strip()

            # Credentials should not appear in output
            self.assertNotIn(token, output)
            self.assertNotIn(password, output)

    def test_file_permissions(self):
        """All credential files should have restrictive permissions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)
            setup_admin_credentials(runtime_dir)

            # Check permissions
            for filename in [
                "config.json",
                "admin-config.json",
                "admin-ui-api-token.txt",
                "admin-ui-password.txt",
                "admin-ui-password-hash.txt",
                "admin-ui-session-secret.txt",
                "admin-ui-totp-secret.txt",
            ]:
                path = runtime_dir / filename
                stat = path.stat()
                perm = stat.st_mode & 0o777
                self.assertEqual(
                    perm,
                    0o600,
                    f"{filename} should have 0600 permissions, got {oct(perm)}",
                )
            state_path = runtime_dir / "admin-totp-state" / "totp-state.json"
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            session_state_path = (
                runtime_dir / "admin-totp-state" / "session-state.json"
            )
            self.assertEqual(
                session_state_path.stat().st_mode & 0o777,
                0o600,
            )
            self.assertEqual(state_path.parent.stat().st_mode & 0o777, 0o700)

            # Runtime directory should be 0700
            stat = runtime_dir.stat()
            perm = stat.st_mode & 0o777
            self.assertEqual(perm, 0o700)

    def test_preserves_existing_devices(self):
        """Should preserve existing device configuration."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # Run setup
            setup_admin_credentials(runtime_dir)

            # Read config and verify devices preserved
            config = json.loads((runtime_dir / "config.json").read_text())
            self.assertIn("test-device", config["devices"])
            self.assertIn("secret_base64", config["devices"]["test-device"])

    def test_preserves_existing_automation_client(self):
        """Should preserve existing API client configuration."""
        with tempfile.TemporaryDirectory() as tmpdir:
            runtime_dir = Path(tmpdir) / "runtime"
            self._create_valid_config(runtime_dir)

            # Run setup
            setup_admin_credentials(runtime_dir)

            # Read config and verify automation client preserved
            config = json.loads((runtime_dir / "config.json").read_text())
            self.assertIn("automation", config["api_clients"])
            self.assertEqual(config["api_clients"]["automation"]["token_sha256"], "a" * 64)


if __name__ == "__main__":
    unittest.main()
