#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

test -f .env
test -f runtime/config.json
. ./.env

if [ "${GATEWAY_DEPLOYMENT_MODE:-direct}" = "cloudflare-tunnel" ]; then
  python3 ../prepare_runtime_permissions.py \
    --runtime-dir runtime \
    --deployment-mode cloudflare-tunnel \
    --enable-admin
else
  python3 ../prepare_runtime_permissions.py \
    --runtime-dir runtime \
    --deployment-mode direct
fi

docker compose config >/dev/null
docker compose up -d --build --force-recreate
docker compose ps
