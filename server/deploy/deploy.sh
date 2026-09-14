#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

test -f .env
test -f runtime/config.json
. ./.env

python3 ../prepare_runtime_permissions.py \
  --runtime-dir runtime \
  --deployment-mode "${GATEWAY_DEPLOYMENT_MODE:-direct}"

docker compose config >/dev/null
docker compose up -d --build --force-recreate
docker compose ps
