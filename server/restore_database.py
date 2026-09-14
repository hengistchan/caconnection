#!/usr/bin/env python3

import argparse
import os
import sqlite3
from pathlib import Path


def restore_database(source: Path, database: Path) -> None:
    if not source.is_file():
        raise ValueError("backup file does not exist")
    with sqlite3.connect(source) as backup:
        if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("backup integrity check failed")
        database.parent.mkdir(parents=True, exist_ok=True)
        temporary = database.with_suffix(database.suffix + ".restore")
        for candidate in (
            temporary,
            Path(str(temporary) + "-wal"),
            Path(str(temporary) + "-shm"),
        ):
            if candidate.exists():
                candidate.unlink()
        with sqlite3.connect(temporary) as restored:
            backup.backup(restored)
            if restored.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("restored database integrity check failed")
        temporary.chmod(0o600)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(database) + suffix)
            if sidecar.exists():
                sidecar.unlink()
        os.replace(temporary, database)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Restore a verified gateway SQLite backup."
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--database",
        type=Path,
        default=Path("/var/lib/gateway/gateway.db"),
    )
    parser.add_argument(
        "--confirm-gateway-stopped",
        action="store_true",
        help="Required acknowledgement that the gateway process is stopped.",
    )
    args = parser.parse_args()
    if not args.confirm_gateway_stopped:
        raise SystemExit("--confirm-gateway-stopped is required")
    restore_database(args.source, args.database)
    print(f"Database restored from: {args.source}")


if __name__ == "__main__":
    main()
