import json
import tempfile
import unittest
from pathlib import Path

from server.setup_feishu import configure, validate_webhook_url


class FeishuSetupTest(unittest.TestCase):
    def test_configures_and_removes_feishu_without_changing_other_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            config_path = runtime / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "devices": {"gateway": {"secret_base64": "secret"}},
                        "api_clients": {},
                        "server": {"retention_days": 30},
                    }
                )
            )
            webhook = (
                "https://open.feishu.cn/open-apis/bot/v2/hook/"
                "abcdefghijklmnop"
            )
            configure(runtime, webhook, "signing-secret", False)
            configured = json.loads(config_path.read_text())
            self.assertEqual(
                webhook,
                configured["notifications"]["feishu"]["webhook_url"],
            )
            self.assertEqual(
                "signing-secret",
                configured["notifications"]["feishu"]["signing_secret"],
            )
            self.assertEqual(30, configured["server"]["retention_days"])
            self.assertEqual(0o600, config_path.stat().st_mode & 0o777)

            configure(runtime, None, None, True)
            removed = json.loads(config_path.read_text())
            self.assertEqual({}, removed["notifications"])

    def test_rejects_non_official_or_insecure_webhooks(self):
        for value in (
            "http://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop",
            "https://example.com/open-apis/bot/v2/hook/abcdefghijklmnop",
            "https://open.feishu.cn/open-apis/bot/v2/hook/short",
        ):
            with self.assertRaises(ValueError):
                validate_webhook_url(value)


if __name__ == "__main__":
    unittest.main()
