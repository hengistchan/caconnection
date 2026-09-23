#!/usr/bin/env python3

"""Tests for admin UI ingress configuration."""

import json
import tempfile
import unittest
from pathlib import Path

from setup_cloudflare import prepare_cloudflare_runtime


class TestCloudflareIngress(unittest.TestCase):
    """Test Cloudflare Tunnel ingress configuration."""

    def setUp(self):
        """Set up test fixtures."""
        self.tmpdir = tempfile.mkdtemp()
        self.runtime_dir = Path(self.tmpdir) / "runtime"
        self.runtime_dir.mkdir()

        # Create mock credentials file
        self.credentials_file = Path(self.tmpdir) / "credentials.json"
        self.tunnel_id = "12345678-1234-1234-1234-123456789abc"
        self.credentials_file.write_text(json.dumps({
            "TunnelID": self.tunnel_id,
            "AccountTag": "test-account",
            "TunnelSecret": "test-secret-base64",
        }))

    def test_ingress_has_admin_path(self):
        """Ingress should include admin path rule."""
        prepare_cloudflare_runtime(
            domain="gateway.example.com",
            tunnel_id=self.tunnel_id,
            credentials_source=self.credentials_file,
            runtime_dir=self.runtime_dir,
        )

        config_path = self.runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # Admin path should be present
        self.assertIn("path: ^/admin(?:/.*)?$", config_content)
        self.assertIn("service: http://admin:3000", config_content)

    def test_ingress_admin_before_gateway(self):
        """Admin path rule should come before the general gateway rule."""
        prepare_cloudflare_runtime(
            domain="gateway.example.com",
            tunnel_id=self.tunnel_id,
            credentials_source=self.credentials_file,
            runtime_dir=self.runtime_dir,
        )

        config_path = self.runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # Find positions
        admin_pos = config_content.find("service: http://admin:3000")
        gateway_pos = config_content.find("service: http://gateway:8787")

        # Admin should come before gateway
        self.assertLess(admin_pos, gateway_pos)

    def test_ingress_preserves_gateway_service(self):
        """Gateway service should still be present for non-admin paths."""
        prepare_cloudflare_runtime(
            domain="gateway.example.com",
            tunnel_id=self.tunnel_id,
            credentials_source=self.credentials_file,
            runtime_dir=self.runtime_dir,
        )

        config_path = self.runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # Gateway service should be present
        self.assertIn("service: http://gateway:8787", config_content)

    def test_ingress_has_404_fallback(self):
        """Should have 404 fallback as last rule."""
        prepare_cloudflare_runtime(
            domain="gateway.example.com",
            tunnel_id=self.tunnel_id,
            credentials_source=self.credentials_file,
            runtime_dir=self.runtime_dir,
        )

        config_path = self.runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # 404 fallback should be last
        self.assertIn("service: http_status:404", config_content)

        # It should be the last service line
        lines = config_content.strip().split("\n")
        last_service_line = None
        for line in lines:
            if "service:" in line:
                last_service_line = line.strip()

        # The line may start with "- " as it's a YAML list item
        self.assertIn("service: http_status:404", last_service_line)

    def test_domain_preserved_exactly(self):
        """Domain should be used exactly as provided, without correction."""
        prepare_cloudflare_runtime(
            domain="my-gatway.example.com",
            tunnel_id=self.tunnel_id,
            credentials_source=self.credentials_file,
            runtime_dir=self.runtime_dir,
        )

        config_path = self.runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # Should use the exact domain as provided
        self.assertIn("hostname: my-gatway.example.com", config_content)
        # Should NOT auto-correct to a different spelling
        self.assertNotIn("my-gateway.example.com", config_content)


class TestV1EventsNotThroughNuxt(unittest.TestCase):
    """Test that /v1/events goes directly to Gateway, not through Nuxt."""

    def test_events_path_not_proxied_to_admin(self):
        """The /v1/events path should not be routed to admin container."""
        tmpdir = tempfile.mkdtemp()
        runtime_dir = Path(tmpdir) / "runtime"
        runtime_dir.mkdir()

        credentials_file = Path(tmpdir) / "credentials.json"
        tunnel_id = "12345678-1234-1234-1234-123456789abc"
        credentials_file.write_text(json.dumps({
            "TunnelID": tunnel_id,
            "AccountTag": "test-account",
            "TunnelSecret": "test-secret-base64",
        }))

        prepare_cloudflare_runtime(
            domain="gateway.example.com",
            tunnel_id=tunnel_id,
            credentials_source=credentials_file,
            runtime_dir=runtime_dir,
        )

        config_path = runtime_dir / "cloudflared-config.yml"
        config_content = config_path.read_text()

        # Check that admin rule has path restriction
        # This ensures /v1/events doesn't match ^/admin
        self.assertIn("path: ^/admin(?:/.*)?$", config_content)

        # The admin rule should only match /admin paths
        # /v1/events should fall through to the gateway rule
        lines = config_content.split("\n")
        in_admin_rule = False
        admin_service = None

        for line in lines:
            if "path: ^/admin" in line:
                in_admin_rule = True
            elif in_admin_rule and "service:" in line:
                admin_service = line.strip()
                in_admin_rule = False

        self.assertEqual(admin_service, "service: http://admin:3000")


if __name__ == "__main__":
    unittest.main()
