#!/usr/bin/env python3

"""
Setup script for CA Connection Admin UI credentials.

This script:
1. Creates a Gateway API token for the admin UI (messages, OTP, pairing)
2. Stores only the token SHA-256 hash in Gateway config.json
3. Generates a random admin password with scrypt/PBKDF2 hash
4. Creates a random session secret
5. Writes credentials to permission-restricted files

Usage:
    python3 server/setup_admin.py --runtime-dir server/deploy/runtime
    python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-api-token
    python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-password
    python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-session-secret
"""

import argparse
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path
from typing import Optional


ADMIN_CLIENT_ID = "admin-ui"
ADMIN_UID = 10002  # Must match Docker container UID
ADMIN_SCOPES = [
    "messages:read",
    "messages:send",
    "otp:claim",
    "pairing:create",
    "notifications:manage",
]

# Required fields in existing Gateway config
REQUIRED_CONFIG_SECTIONS = ["devices", "api_clients", "server"]


def generate_scrypt_hash(password: str) -> str:
    """Generate scrypt hash for a password.

    Uses PBKDF2-SHA256 as a fallback when scrypt is not available.
    For production Linux servers with OpenSSL 1.1+, scrypt is preferred.
    """
    import hashlib
    salt = secrets.token_hex(32)
    try:
        # Try scrypt first (requires OpenSSL 1.1+)
        key = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            maxmem=128 * 1024 * 1024,
            dklen=64,
        )
        return f"scrypt:{salt}:{key.hex()}"
    except AttributeError:
        # Fallback to PBKDF2-SHA256 (compatible with older OpenSSL)
        key = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations=600_000,
            dklen=64,
        )
        return f"pbkdf2:{salt}:{key.hex()}"


def write_private_file(path: Path, content: str, mode: int = 0o600) -> None:
    """Write content to a file with restricted permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)

    # Write to temporary file first
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        path.chmod(mode)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def load_existing_config(config_path: Path) -> dict:
    """Load existing Gateway config if it exists."""
    if config_path.exists():
        return json.loads(config_path.read_text(encoding="utf-8"))
    return {}


def validate_gateway_config(config: dict) -> list[str]:
    """Validate that Gateway config has required sections.

    Returns list of validation errors, empty if valid.
    """
    errors = []

    # Check for devices section
    if "devices" not in config:
        errors.append("Missing 'devices' section")
    elif not config["devices"]:
        errors.append("Empty 'devices' section - no Android device configured")
    else:
        # Validate each device has a secret
        for device_id, device_config in config["devices"].items():
            if "secret_base64" not in device_config:
                errors.append(f"Device '{device_id}' missing 'secret_base64'")

    # Check for api_clients section
    if "api_clients" not in config:
        errors.append("Missing 'api_clients' section")

    # Check for server section
    if "server" not in config:
        errors.append("Missing 'server' section")

    return errors


def setup_admin_credentials(
    runtime_dir: Path,
    rotate_api_token: bool = False,
    rotate_password: bool = False,
    rotate_session_secret: bool = False,
) -> None:
    """Set up admin UI credentials."""
    runtime = runtime_dir.resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)

    # File paths
    config_path = runtime / "config.json"
    admin_config_path = runtime / "admin-config.json"
    api_token_path = runtime / "admin-ui-api-token.txt"
    password_file_path = runtime / "admin-ui-password.txt"
    password_hash_path = runtime / "admin-ui-password-hash.txt"
    session_secret_path = runtime / "admin-ui-session-secret.txt"

    # Load existing config - MUST exist for production safety
    if not config_path.exists():
        print(
            "ERROR: Gateway config.json does not exist at: {}\n"
            "Run setup_production.py first to create the base configuration.".format(
                config_path
            ),
            file=sys.stderr,
        )
        sys.exit(1)

    config = load_existing_config(config_path)

    # Validate existing config has required sections
    validation_errors = validate_gateway_config(config)
    if validation_errors:
        print(
            "ERROR: Gateway config.json is invalid:\n" +
            "\n".join(f"  - {err}" for err in validation_errors) +
            "\nFix the config or run setup_production.py to regenerate.",
            file=sys.stderr,
        )
        sys.exit(1)

    admin_config = {}
    if admin_config_path.exists():
        admin_config = json.loads(admin_config_path.read_text(encoding="utf-8"))

    # Track changes
    changes = []

    # 1. API Token setup
    api_clients = config.setdefault("api_clients", {})

    if rotate_api_token or ADMIN_CLIENT_ID not in api_clients:
        # Generate new token
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

        api_clients[ADMIN_CLIENT_ID] = {
            "token_sha256": token_hash,
            "scopes": ADMIN_SCOPES,
        }

        # Write token to private file
        write_private_file(api_token_path, token + "\n")
        changes.append("API token")
    elif not api_token_path.is_file():
        print("ERROR: API token file missing. Use --rotate-api-token to generate.", file=sys.stderr)
        sys.exit(1)
    elif api_clients[ADMIN_CLIENT_ID].get("scopes") != ADMIN_SCOPES:
        api_clients[ADMIN_CLIENT_ID]["scopes"] = ADMIN_SCOPES
        changes.append("API token scopes")

    # 2. Admin password setup
    if rotate_password or "password_hash" not in admin_config:
        # Generate random password (24 chars, alphanumeric)
        password = secrets.token_urlsafe(18)[:24]
        password_hash = generate_scrypt_hash(password)

        admin_config["password_hash"] = password_hash

        # Write password to separate file (only place it appears in cleartext)
        write_private_file(password_file_path, password + "\n")
        # Write password hash to separate file for Docker secret mounting
        write_private_file(password_hash_path, password_hash + "\n")
        changes.append("admin password")
    elif not password_file_path.is_file():
        print("WARNING: Password file missing but hash exists. Password file will not be regenerated.", file=sys.stderr)

    # 3. Session secret setup
    if rotate_session_secret or "session_secret" not in admin_config:
        session_secret = secrets.token_hex(32)
        admin_config["session_secret"] = session_secret
        # Write session secret to separate file for Docker secret mounting
        write_private_file(session_secret_path, session_secret + "\n")
        changes.append("session secret")

    # Write admin config (reference file, not used by Docker secrets)
    write_private_file(
        admin_config_path,
        json.dumps(admin_config, indent=2, ensure_ascii=False) + "\n",
    )

    # Write Gateway config (only contains token hash, never the token itself)
    write_private_file(
        config_path,
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
    )

    # Print summary (no secrets!)
    print(f"Admin credentials prepared in: {runtime}")
    if changes:
        print(f"Changes: {', '.join(changes)}")
    else:
        print("No changes (credentials already exist)")
    print("Files created:")
    print(f"  - {config_path.name} (Gateway config with token hash)")
    print(f"  - {admin_config_path.name} (admin config)")
    print(f"  - {api_token_path.name} (API token - secret)")
    print(f"  - {password_file_path.name} (admin password - secret)")
    print(f"  - {password_hash_path.name} (password hash for Docker)")
    print(f"  - {session_secret_path.name} (session secret for Docker)")
    print()
    print("IMPORTANT: No credential values were printed.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set up CA Connection Admin UI credentials."
    )
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        required=True,
        help="Path to runtime directory for credential files",
    )
    parser.add_argument(
        "--rotate-api-token",
        action="store_true",
        help="Rotate the Gateway API token",
    )
    parser.add_argument(
        "--rotate-password",
        action="store_true",
        help="Rotate the admin password",
    )
    parser.add_argument(
        "--rotate-session-secret",
        action="store_true",
        help="Rotate the session signing secret",
    )

    args = parser.parse_args()

    setup_admin_credentials(
        args.runtime_dir,
        rotate_api_token=args.rotate_api_token,
        rotate_password=args.rotate_password,
        rotate_session_secret=args.rotate_session_secret,
    )


if __name__ == "__main__":
    main()
