import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from server.prepare_runtime_permissions import (
    ADMIN_UID,
    CLOUDFLARED_UID,
    GATEWAY_UID,
    prepare_runtime_permissions,
)
from server.production_preflight import ProductionHostAudit, valid_domain
from server.setup_cloudflare import prepare_cloudflare_runtime


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
            self.assertEqual(
                "https://gateway.example.com",
                config["server"]["pairing_public_endpoint"],
            )
            self.assertEqual(
                20,
                config["server"]["pairing_claim_requests_per_minute"],
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
            self.assertEqual(
                [
                    "GATEWAY_DOMAIN=gateway.example.com",
                    "GATEWAY_DEPLOYMENT_MODE=direct",
                    "COMPOSE_FILE=compose.yaml",
                ],
                (Path(temporary) / ".env").read_text().splitlines(),
            )

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

    def test_cloudflare_mode_selects_private_tunnel_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env_file = Path(temporary) / ".env"
            subprocess.run(
                [
                    sys.executable,
                    "server/setup_production.py",
                    "--domain",
                    "gateway.example.com",
                    "--deployment-mode",
                    "cloudflare-tunnel",
                    "--runtime-dir",
                    str(Path(temporary) / "runtime"),
                    "--env-file",
                    str(env_file),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                [
                    "GATEWAY_DOMAIN=gateway.example.com",
                    "GATEWAY_DEPLOYMENT_MODE=cloudflare-tunnel",
                    "COMPOSE_FILE=compose.cloudflare.yaml",
                ],
                env_file.read_text().splitlines(),
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

    def test_cloudflare_runtime_is_private_and_matches_tunnel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            credentials = root / "source.json"
            credentials.write_text(
                json.dumps(
                    {
                        "AccountTag": "account",
                        "TunnelSecret": "secret",
                        "TunnelID": "12345678-1234-4234-8234-123456789abc",
                    }
                )
            )
            runtime = root / "runtime"

            prepare_cloudflare_runtime(
                "gateway.example.com",
                "12345678-1234-4234-8234-123456789abc",
                credentials,
                runtime,
            )

            copied = runtime / "cloudflare-tunnel-credentials.json"
            config = runtime / "cloudflared-config.yml"
            self.assertEqual(0o600, copied.stat().st_mode & 0o777)
            self.assertEqual(0o600, config.stat().st_mode & 0o777)
            self.assertIn(
                "hostname: gateway.example.com",
                config.read_text(),
            )
            self.assertIn(
                "service: http://gateway:8787",
                config.read_text(),
            )
            self.assertNotIn("TunnelSecret", config.read_text())

            with self.assertRaisesRegex(ValueError, "does not match"):
                prepare_cloudflare_runtime(
                    "gateway.example.com",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    credentials,
                    runtime,
                )


class RuntimePermissionTest(unittest.TestCase):
    def test_cloudflare_secret_ownership_is_prepared_for_non_root_users(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            files = [
                runtime / "config.json",
                runtime / "cloudflared-config.yml",
                runtime / "cloudflare-tunnel-credentials.json",
            ]
            for path in files:
                path.write_text("private")
                path.chmod(0o600)
            calls = []

            prepare_runtime_permissions(
                runtime,
                "cloudflare-tunnel",
                effective_uid=0,
                chown=lambda path, uid, gid: calls.append(
                    (path.name, uid, gid)
                ),
            )

            self.assertEqual(
                [
                    ("config.json", GATEWAY_UID, GATEWAY_UID),
                    (
                        "cloudflared-config.yml",
                        CLOUDFLARED_UID,
                        CLOUDFLARED_UID,
                    ),
                    (
                        "cloudflare-tunnel-credentials.json",
                        CLOUDFLARED_UID,
                        CLOUDFLARED_UID,
                    ),
                ],
                calls,
            )
            self.assertTrue(
                all(path.stat().st_mode & 0o777 == 0o400 for path in files)
            )

    def test_non_root_cannot_silently_keep_wrong_secret_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            config = runtime / "config.json"
            config.write_text("private")
            with self.assertRaisesRegex(PermissionError, "root deployment"):
                prepare_runtime_permissions(
                    runtime,
                    "direct",
                    effective_uid=12345,
                )

    def test_admin_secrets_are_required_and_assigned_to_admin_uid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            files = [
                runtime / "config.json",
                runtime / "cloudflared-config.yml",
                runtime / "cloudflare-tunnel-credentials.json",
                runtime / "admin-ui-api-token.txt",
                runtime / "admin-ui-password-hash.txt",
                runtime / "admin-ui-session-secret.txt",
                runtime / "admin-ui-totp-secret.txt",
            ]
            for path in files:
                path.write_text("private")
            state_dir = runtime / "admin-totp-state"
            state_dir.mkdir()
            state_path = state_dir / "totp-state.json"
            state_path.write_text('{"version":1,"recoveryCodeHashes":[]}')
            calls = []
            prepare_runtime_permissions(
                runtime,
                "cloudflare-tunnel",
                enable_admin=True,
                effective_uid=0,
                chown=lambda path, uid, gid: calls.append(
                    (path.name, uid, gid)
                ),
            )
            self.assertEqual(
                {
                    ("admin-ui-api-token.txt", ADMIN_UID, ADMIN_UID),
                    ("admin-ui-password-hash.txt", ADMIN_UID, ADMIN_UID),
                    ("admin-ui-session-secret.txt", ADMIN_UID, ADMIN_UID),
                    ("admin-ui-totp-secret.txt", ADMIN_UID, ADMIN_UID),
                    ("admin-totp-state", ADMIN_UID, ADMIN_UID),
                    ("totp-state.json", ADMIN_UID, ADMIN_UID),
                },
                {
                    item for item in calls
                    if item[0].startswith("admin-ui-")
                    or item[0] in {"admin-totp-state", "totp-state.json"}
                },
            )
            self.assertEqual(
                state_path.stat().st_mode & 0o777,
                0o600,
            )
            self.assertEqual(state_dir.stat().st_mode & 0o777, 0o700)
            for path in files:
                self.assertEqual(path.stat().st_mode & 0o777, 0o400)

            (runtime / "admin-ui-session-secret.txt").unlink()
            with self.assertRaisesRegex(ValueError, "required runtime"):
                prepare_runtime_permissions(
                    runtime,
                    "cloudflare-tunnel",
                    enable_admin=True,
                    effective_uid=0,
                )


class ProductionHostAuditTest(unittest.TestCase):
    @staticmethod
    def completed(
        stdout: str = "",
        returncode: int = 0,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=[],
            returncode=returncode,
            stdout=stdout,
            stderr="",
        )

    def test_clean_linux_host_passes_with_expected_warnings(self) -> None:
        commands = {
            ("docker", "info", "--format", "{{.ServerVersion}}"):
                self.completed("29.4.0\n"),
            ("docker", "compose", "version", "--short"):
                self.completed("5.1.2\n"),
            ("timedatectl", "show", "--property=NTPSynchronized", "--value"):
                self.completed("yes\n"),
            ("ss", "-H", "-ltn"): self.completed(""),
            ("ss", "-H", "-lun"): self.completed(""),
        }

        def runner(command, **_kwargs):
            return commands[tuple(command)]

        response = Mock(status=200)
        response.close = Mock()
        audit = ProductionHostAudit(
            "gateway.example.com",
            Path("/tmp"),
            command_runner=runner,
            command_lookup=lambda name: f"/usr/bin/{name}",
            system_name=lambda: "Linux",
            disk_usage=lambda _path: SimpleNamespace(free=8 * 1024**3),
            address_lookup=lambda *_args, **_kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))
            ],
            url_open=lambda *_args, **_kwargs: response,
        )
        results = audit.audit()

        self.assertFalse([item for item in results if item.status == "FAIL"])
        self.assertEqual(
            {"Firewall", "Runtime credentials"},
            {item.name for item in results if item.status == "WARN"},
        )
        response.close.assert_called_once()

    def test_host_blockers_are_reported_without_modification(self) -> None:
        commands = {
            ("timedatectl", "show", "--property=NTPSynchronized", "--value"):
                self.completed("no\n"),
            ("ss", "-H", "-ltn"):
                self.completed("LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n"),
            ("ss", "-H", "-lun"): self.completed(""),
        }

        def runner(command, **_kwargs):
            return commands[tuple(command)]

        audit = ProductionHostAudit(
            "gateway.example.com",
            Path("/tmp"),
            require_runtime=True,
            command_runner=runner,
            command_lookup=lambda name: (
                None if name == "docker" else f"/usr/bin/{name}"
            ),
            system_name=lambda: "Darwin",
            disk_usage=lambda _path: SimpleNamespace(free=1024),
            address_lookup=lambda *_args, **_kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))
            ],
            url_open=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                OSError("offline")
            ),
        )
        results = audit.audit()
        failed = {item.name for item in results if item.status == "FAIL"}

        self.assertTrue(
            {
                "Operating system",
                "Disk space",
                "Docker Engine",
                "Docker Compose",
                "Clock synchronization",
                "Public ports",
                "DNS",
                "Runtime credentials",
            }.issubset(failed)
        )

    def test_runtime_files_must_be_private_and_match_domain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            deploy = Path(temporary)
            runtime = deploy / "runtime"
            runtime.mkdir(mode=0o700)
            files = {
                deploy / ".env": (
                    "GATEWAY_DOMAIN=gateway.example.com\n"
                    "GATEWAY_DEPLOYMENT_MODE=direct\n"
                    "COMPOSE_FILE=compose.yaml\n"
                ),
                runtime / "config.json":
                    '{"devices":{"phone":{}},"api_clients":{"client":{}}}\n',
                runtime / "android-provisioning.json":
                    '{"endpoint":"https://gateway.example.com","enabled":true}\n',
                runtime / "automation-api-token.txt": "A" * 43 + "\n",
            }
            for path, content in files.items():
                path.write_text(content)
                path.chmod(0o600)
            audit = ProductionHostAudit(
                "gateway.example.com",
                deploy,
                require_runtime=True,
            )
            audit.check_runtime_files()
            self.assertEqual("PASS", audit.results[0].status)

            (runtime / "config.json").chmod(0o644)
            audit.results.clear()
            audit.check_runtime_files()
            self.assertEqual("FAIL", audit.results[0].status)

            (runtime / "config.json").chmod(0o600)
            (deploy / ".env").write_text(
                "GATEWAY_DOMAIN=gateway.example.com\n"
                "GATEWAY_DEPLOYMENT_MODE=cloudflare-tunnel\n"
                "COMPOSE_FILE=compose.cloudflare.yaml\n"
            )
            (deploy / ".env").chmod(0o600)
            audit.results.clear()
            audit.check_runtime_files()
            self.assertEqual("FAIL", audit.results[0].status)
            self.assertIn("Cloudflare Tunnel", audit.results[0].detail)

    def test_domain_validation(self) -> None:
        self.assertEqual(
            "gateway.example.com",
            valid_domain(" Gateway.Example.Com "),
        )
        with self.assertRaises(Exception):
            valid_domain("127.0.0.1")


if __name__ == "__main__":
    unittest.main()
