#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

test -f .env
test -f runtime/config.json

docker compose config >/dev/null
docker compose up -d --build --force-recreate
docker compose ps
