#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 runtime/backups/gateway-TIMESTAMP.db" >&2
  exit 2
fi

cd "$(dirname "$0")"
SOURCE="$1"
test -f "$SOURCE"
SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
SOURCE_PATH="${SOURCE_DIR}/$(basename "$SOURCE")"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/caconnection-restore.XXXXXX")"
TEMP_SOURCE="${TEMP_DIR}/source.db"
chmod 700 "$TEMP_DIR"
cp "$SOURCE_PATH" "$TEMP_SOURCE"
# The temporary directory remains owner-only. The file itself must be readable
# by the non-root gateway UID through Docker's bind mount.
chmod 644 "$TEMP_SOURCE"

docker compose stop gateway
RESTART_REQUIRED=1
restart_on_exit() {
  if [ "$RESTART_REQUIRED" -eq 1 ]; then
    docker compose start gateway >/dev/null 2>&1 || true
  fi
  rm -f "$TEMP_SOURCE"
  rmdir "$TEMP_DIR" >/dev/null 2>&1 || true
}
trap restart_on_exit EXIT INT TERM

docker compose run --rm --no-deps \
  -v "${TEMP_SOURCE}:/tmp/source.db:ro" \
  --entrypoint node gateway \
  /app/dist/operations/restore-database.js \
  --source /tmp/source.db \
  --database /var/lib/gateway/gateway.db \
  --confirm-gateway-stopped

docker compose start gateway
for ATTEMPT in $(seq 1 30); do
  if docker compose exec -T gateway node -e \
    "fetch('http://127.0.0.1:8787/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1
  then
    RESTART_REQUIRED=0
    echo "Gateway restore verified healthy."
    exit 0
  fi
  sleep 1
done

echo "Gateway did not become healthy after restore." >&2
exit 1
