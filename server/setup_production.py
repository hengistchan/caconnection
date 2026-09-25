#!/usr/bin/env python3

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path


DOMAIN_PATTERN = re.compile(
    r"(?=^.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}"
    r"[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$"
)


def valid_domain(value: str) -> str:
    normalized = value.strip().lower()
    if not DOMAIN_PATTERN.fullmatch(normalized):
        raise ValueError("A valid DNS hostname is required")
    return normalized


def provisioning_signature(
    signing_secret_base64: str,
    endpoint: str,
    device_id: str,
    shared_secret_base64: str,
    certificate_pin_sha256_base64: str,
    enabled: bool,
) -> str:
    """HMAC-SHA256 over the canonical provisioning message.

    Must stay byte-identical to GatewayProvisioning.signingMessage on the
    Android side: the key is the secret the device already holds (the new
    secret is wrong during rotation, since the device still trusts the old
    one until the document is applied).
    """
    message = "\n".join(
        [
            "caconnection/provisioning/v1",
            endpoint,
            device_id,
            shared_secret_base64,
            certificate_pin_sha256_base64 or "",
            "true" if enabled else "false",
        ]
    ).encode("utf-8")
    key = base64.b64decode(signing_secret_base64)
    return base64.b64encode(
        hmac.new(key, message, hashlib.sha256).digest()
    ).decode("ascii")


def write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


def main() -> None:
    root = Path(__file__).resolve().parent / "deploy"
    parser = argparse.ArgumentParser(
        description="Prepare ignored production gateway runtime files."
    )
    parser.add_argument("--domain", required=True)
    parser.add_argument("--device-id", default="xiaomi-gateway")
    parser.add_argument("--client-id", default="automation")
    parser.add_argument("--runtime-dir", type=Path, default=root / "runtime")
    parser.add_argument("--env-file", type=Path, default=root / ".env")
    parser.add_argument(
        "--deployment-mode",
        choices=("direct", "cloudflare-tunnel"),
        default="direct",
    )
    parser.add_argument("--rotate-api-token", action="store_true")
    parser.add_argument("--rotate-device-secret", action="store_true")
    args = parser.parse_args()

    try:
        domain = valid_domain(args.domain)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", args.device_id):
        raise SystemExit("Invalid device ID")
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", args.client_id):
        raise SystemExit("Invalid API client ID")

    runtime = args.runtime_dir.resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    config_path = runtime / "config.json"
    data = (
        json.loads(config_path.read_text(encoding="utf-8"))
        if config_path.exists()
        else {}
    )
    devices = data.setdefault("devices", {})
    previous_device_secret = devices.get(args.device_id, {}).get("secret_base64")
    if args.rotate_device_secret or args.device_id not in devices:
        devices[args.device_id] = {
            "secret_base64": base64.b64encode(
                secrets.token_bytes(32)
            ).decode("ascii")
        }
    device = devices[args.device_id]

    clients = data.setdefault("api_clients", {})
    token_path = runtime / f"{args.client_id}-api-token.txt"
    if args.rotate_api_token or args.client_id not in clients:
        token = secrets.token_urlsafe(32)
        clients[args.client_id] = {
            "token_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "scopes": ["messages:read", "otp:claim"],
        }
        write_private(token_path, token + "\n")
    elif not token_path.is_file():
        raise SystemExit(
            "API token file is missing; rerun with --rotate-api-token"
        )

    data["server"] = {
        "retention_days": 30,
        "otp_max_age_seconds": 600,
        "ingest_requests_per_minute": 120,
        "device_requests_per_minute": 120,
        "api_auth_requests_per_minute": 120,
        "api_requests_per_minute": 60,
        "pairing_create_requests_per_minute": 20,
        "pairing_claim_requests_per_minute": 20,
        "pairing_public_endpoint": f"https://{domain}",
        "pairing_certificate_pin_sha256_base64": "",
        "max_concurrent_requests": 32,
        "trust_proxy_headers": True,
    }
    write_private(
        config_path,
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
    )
    # Signed with the secret the device currently holds — after a rotation
    # that is the previous secret, otherwise the one in this document (first
    # provisioning is accepted unsigned by a not-yet-configured device).
    provisioning_endpoint = f"https://{domain}"
    provisioning_pin = ""
    provisioning_enabled = True
    signing_secret = previous_device_secret or device["secret_base64"]
    write_private(
        runtime / "android-provisioning.json",
        json.dumps(
            {
                "schemaVersion": 1,
                "endpoint": provisioning_endpoint,
                "deviceId": args.device_id,
                "sharedSecretBase64": device["secret_base64"],
                "certificatePinSha256Base64": provisioning_pin,
                "tlsValidation": "SYSTEM_CA",
                "enabled": provisioning_enabled,
                "signatureBase64": provisioning_signature(
                    signing_secret,
                    provisioning_endpoint,
                    args.device_id,
                    device["secret_base64"],
                    provisioning_pin,
                    provisioning_enabled,
                ),
            },
            indent=2,
        )
        + "\n",
    )
    compose_file = (
        "compose.cloudflare.yaml"
        if args.deployment_mode == "cloudflare-tunnel"
        else "compose.yaml"
    )
    write_private(
        args.env_file.resolve(),
        "\n".join(
            (
                f"GATEWAY_DOMAIN={domain}",
                f"GATEWAY_DEPLOYMENT_MODE={args.deployment_mode}",
                f"COMPOSE_FILE={compose_file}",
                "",
            )
        ),
    )
    backups = runtime / "backups"
    backups.mkdir(exist_ok=True)
    backups.chmod(0o700)

    print(f"Prepared production runtime: {runtime}")
    print(f"Domain: {domain}")
    print(f"Device ID: {args.device_id}")
    print(f"API client ID: {args.client_id}")
    print(f"Deployment mode: {args.deployment_mode}")
    print("Device and API credentials were written to private files.")
    print("No credential value was printed.")


if __name__ == "__main__":
    main()
