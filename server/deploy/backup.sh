#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
KEEP="${GATEWAY_BACKUP_KEEP:-14}"
case "$KEEP" in
  ''|*[!0-9]*|0)
    echo "GATEWAY_BACKUP_KEEP must be a positive integer." >&2
    exit 2
    ;;
esac
mkdir -p runtime/backups
chmod 700 runtime/backups

OUTPUT="$(docker compose exec -T gateway \
  python -m server.backup_database \
  --database /var/lib/gateway/gateway.db \
  --output-dir /var/lib/gateway/backups \
  --keep "$KEEP")"
printf '%s\n' "$OUTPUT"

BACKUP_PATH="$(printf '%s\n' "$OUTPUT" |
  sed -n 's/^Backup created: //p' |
  tail -n 1)"
BACKUP_NAME="${BACKUP_PATH##*/}"
case "$BACKUP_NAME" in
  gateway-*.db) ;;
  *)
    echo "Unable to identify the created backup." >&2
    exit 1
    ;;
esac

docker compose cp "gateway:${BACKUP_PATH}" "runtime/backups/${BACKUP_NAME}"
chmod 600 "runtime/backups/${BACKUP_NAME}"

CONTAINER_HASH="$(docker compose exec -T gateway \
  sha256sum "$BACKUP_PATH" | awk '{print $1}')"
HOST_HASH="$(sha256sum "runtime/backups/${BACKUP_NAME}" | awk '{print $1}')"
test "$CONTAINER_HASH" = "$HOST_HASH"

INDEX=0
for FILE in $(ls -1t runtime/backups/gateway-*.db 2>/dev/null || true); do
  INDEX=$((INDEX + 1))
  if [ "$INDEX" -gt "$KEEP" ]; then
    rm -f "$FILE"
  fi
done

echo "Exported verified backup: runtime/backups/${BACKUP_NAME}"
