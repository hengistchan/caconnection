#!/usr/bin/env python3

"""Configure the Feishu custom-bot webhook without printing secret values."""

import argparse
import getpass
import json
import os
import re
import secrets
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse


WEBHOOK_PATH = re.compile(r"^/open-apis/bot/v2/hook/[A-Za-z0-9_-]{16,256}$")


def validate_webhook_url(value: str) -> str:
    normalized = value.strip()
    parsed = urlparse(normalized)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in {"open.feishu.cn", "open.larksuite.com"}
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not WEBHOOK_PATH.fullmatch(parsed.path)
    ):
        raise ValueError("A valid official Feishu custom-bot webhook is required")
    return normalized


def write_private(path: Path, value: str) -> None:
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    )
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_secret(path: Optional[Path], prompt: str) -> str:
    if path is not None:
        return path.read_text(encoding="utf-8").strip()
    return getpass.getpass(prompt).strip()


def configure(
    runtime_dir: Path,
    webhook_url: Optional[str],
    signing_secret: Optional[str],
    remove: bool,
) -> None:
    runtime = runtime_dir.resolve()
    config_path = runtime / "config.json"
    if not config_path.is_file():
        raise ValueError("Gateway config.json does not exist")
    data = json.loads(config_path.read_text(encoding="utf-8"))
    notifications = data.setdefault("notifications", {})
    if not isinstance(notifications, dict):
        raise ValueError("Gateway notifications configuration is invalid")

    if remove:
        notifications.pop("feishu", None)
        if not notifications:
            data["notifications"] = {}
    else:
        if webhook_url is None:
            raise ValueError("Feishu webhook URL is required")
        feishu = {"webhook_url": validate_webhook_url(webhook_url)}
        if signing_secret:
            if len(signing_secret) > 256:
                raise ValueError("Feishu signing secret is too long")
            feishu["signing_secret"] = signing_secret
        notifications["feishu"] = feishu

    write_private(
        config_path,
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Configure the protected Feishu webhook in Gateway config."
    )
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--webhook-url-file", type=Path)
    parser.add_argument("--signing-secret-file", type=Path)
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.remove and (
        args.webhook_url_file is not None
        or args.signing_secret_file is not None
    ):
        raise SystemExit("--remove cannot be combined with secret input files")
    try:
        webhook_url = (
            None
            if args.remove
            else read_secret(
                args.webhook_url_file,
                "Feishu webhook URL (input hidden): ",
            )
        )
        signing_secret = (
            None
            if args.remove
            else (
                read_secret(
                    args.signing_secret_file,
                    "Feishu signing secret, leave empty if unused (input hidden): ",
                )
                if args.signing_secret_file is not None
                else ""
            )
        )
        configure(
            args.runtime_dir,
            webhook_url,
            signing_secret,
            args.remove,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
    print("Feishu Gateway configuration updated.")
    print("No webhook or signing-secret value was printed.")


if __name__ == "__main__":
    main()
