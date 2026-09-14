#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
. ./.env
test -f runtime/automation-api-token.txt

docker compose ps
curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/health"
echo
curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/ready"
echo
curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/version"
echo
docker compose exec -T gateway \
  python -m server.protocol_smoke \
  --url "https://${GATEWAY_DOMAIN}" \
  --connect-host caddy \
  --config /run/secrets/gateway_config

TOKEN="$(cat runtime/automation-api-token.txt)"
if ! printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9_-]{32,128}$'; then
  echo "Invalid API token file format." >&2
  exit 1
fi
curl --config - >/dev/null <<EOF
url = "https://${GATEWAY_DOMAIN}/v1/messages?limit=1"
fail
silent
show-error
output = "/dev/null"
header = "Authorization: Bearer ${TOKEN}"
EOF
unset TOKEN
echo "Authenticated message API: PASS"
