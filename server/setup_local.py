#!/usr/bin/env python3

import argparse
import base64
import json
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the ignored local Phase 4 receiver configuration."
    )
    parser.add_argument("--device-id", default="xiaomi-gateway")
    parser.add_argument(
        "--config",
        default=str(Path(__file__).with_name("config.json")),
    )
    args = parser.parse_args()

    path = Path(args.config)
    if path.exists():
        print(f"Existing configuration preserved: {path}")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    secret = base64.b64encode(os.urandom(32)).decode("ascii")
    data = {"devices": {args.device_id: {"secret_base64": secret}}}
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)
    print(f"Created local configuration: {path}")
    print(f"Device ID: {args.device_id}")
    print("Secret was written to the ignored configuration and was not printed.")


if __name__ == "__main__":
    main()
