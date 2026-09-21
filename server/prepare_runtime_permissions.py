#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
from typing import Callable, Optional


GATEWAY_UID = 10001
CLOUDFLARED_UID = 65532
ADMIN_UID = 10002


def prepare_runtime_permissions(
    runtime_dir: Path,
    deployment_mode: str,
    enable_admin: bool = False,
    effective_uid: Optional[int] = None,
    chown: Callable[[Path, int, int], None] = os.chown,
) -> None:
    if deployment_mode not in {"direct", "cloudflare-tunnel"}:
        raise ValueError("unsupported deployment mode")
    runtime = runtime_dir.resolve()

    # Base assignments (always required)
    assignments = [
        (runtime / "config.json", GATEWAY_UID),
    ]

    # Cloudflare tunnel files (only for cloudflare-tunnel mode)
    if deployment_mode == "cloudflare-tunnel":
        assignments.extend(
            (
                (runtime / "cloudflared-config.yml", CLOUDFLARED_UID),
                (
                    runtime / "cloudflare-tunnel-credentials.json",
                    CLOUDFLARED_UID,
                ),
            )
        )

    # Admin UI files (only when admin is enabled)
    if enable_admin:
        session_state_path = (
            runtime / "admin-totp-state" / "session-state.json"
        )
        if not session_state_path.exists():
            session_state_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(
                session_state_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as state_file:
                    json.dump(
                        {
                            "version": 1,
                            "generation": 1,
                            "revokedSessions": {},
                        },
                        state_file,
                        indent=2,
                    )
                    state_file.write("\n")
                    state_file.flush()
                    os.fsync(state_file.fileno())
            except Exception:
                session_state_path.unlink(missing_ok=True)
                raise
        assignments.extend(
            (
                (runtime / "admin-ui-api-token.txt", ADMIN_UID),
                (runtime / "admin-ui-password-hash.txt", ADMIN_UID),
                (runtime / "admin-ui-session-secret.txt", ADMIN_UID),
                (runtime / "admin-ui-totp-secret.txt", ADMIN_UID),
            )
        )
    writable_directories = (
        [(runtime / "admin-totp-state", ADMIN_UID)]
        if enable_admin
        else []
    )
    writable_assignments = (
        [
            (runtime / "admin-totp-state" / "totp-state.json", ADMIN_UID),
            (runtime / "admin-totp-state" / "session-state.json", ADMIN_UID),
        ]
        if enable_admin
        else []
    )

    missing = [
        path
        for path, _uid in [*assignments, *writable_assignments]
        if not path.is_file()
    ]
    missing.extend(
        path
        for path, _uid in writable_directories
        if not path.is_dir()
    )
    if missing:
        raise ValueError("required runtime secret file is missing")
    uid = os.geteuid() if effective_uid is None else effective_uid
    runtime.chmod(0o700)
    for path, owner_uid in assignments:
        stat = path.stat()
        if uid == 0:
            chown(path, owner_uid, owner_uid)
        elif stat.st_uid != owner_uid or stat.st_gid != owner_uid:
            raise PermissionError(
                "runtime secret ownership requires a root deployment step"
            )
        path.chmod(0o400)
    for path, owner_uid in writable_assignments:
        stat = path.stat()
        if uid == 0:
            chown(path, owner_uid, owner_uid)
        elif stat.st_uid != owner_uid or stat.st_gid != owner_uid:
            raise PermissionError(
                "runtime secret ownership requires a root deployment step"
            )
        path.chmod(0o600)
    for path, owner_uid in writable_directories:
        stat = path.stat()
        if uid == 0:
            chown(path, owner_uid, owner_uid)
        elif stat.st_uid != owner_uid or stat.st_gid != owner_uid:
            raise PermissionError(
                "runtime secret ownership requires a root deployment step"
            )
        path.chmod(0o700)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Set Linux host ownership for non-root Gateway and cloudflared "
            "Docker secret bind mounts."
        )
    )
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument(
        "--deployment-mode",
        required=True,
        choices=("direct", "cloudflare-tunnel"),
    )
    parser.add_argument(
        "--enable-admin",
        action="store_true",
        help="Include admin UI secret files in permission assignments",
    )
    args = parser.parse_args()
    prepare_runtime_permissions(
        args.runtime_dir,
        args.deployment_mode,
        enable_admin=args.enable_admin,
    )
    print("Runtime secret ownership and read-only permissions prepared.")
    print("No secret content was read or printed.")


if __name__ == "__main__":
    main()
