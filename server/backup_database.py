#!/usr/bin/env python3

import argparse
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def backup_database(database: Path, output_dir: Path, keep: int = 14) -> Path:
    if keep < 1:
        raise ValueError("keep must be at least 1")
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = output_dir / f"gateway-{timestamp}.db"
    temporary = destination.with_suffix(".db.partial")
    try:
        with sqlite3.connect(database) as source, sqlite3.connect(
            temporary
        ) as target:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("backup integrity check failed")
        temporary.chmod(0o600)
        temporary.replace(destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    backups = sorted(
        output_dir.glob("gateway-*.db"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for stale in backups[keep:]:
        stale.unlink()
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a consistent SQLite gateway backup."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Path("/var/lib/gateway/gateway.db"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/var/lib/gateway/backups"),
    )
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args()
    backup = backup_database(args.database, args.output_dir, args.keep)
    print(f"Backup created: {backup}")


if __name__ == "__main__":
    main()
