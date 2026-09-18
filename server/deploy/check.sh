#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
. ./.env
test -f runtime/automation-api-token.txt

docker compose ps

wait_for_url() {
  URL="$1"
  LABEL="$2"
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 60 ]; do
    if curl --fail --silent --show-error "$URL" >/dev/null 2>&1; then
      return 0
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
  done
  echo "Timed out waiting for ${LABEL}: ${URL}" >&2
  return 1
}

wait_for_url "https://${GATEWAY_DOMAIN}/health" "Gateway health"
wait_for_url "https://${GATEWAY_DOMAIN}/ready" "Gateway readiness"

curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/health"
echo
curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/ready"
echo
curl --fail --silent --show-error "https://${GATEWAY_DOMAIN}/version"
echo

if [ "${GATEWAY_DEPLOYMENT_MODE:-direct}" = "cloudflare-tunnel" ]; then
  wait_for_url "https://${GATEWAY_DOMAIN}/admin/api/health" "Admin health"
  curl --fail --silent --show-error \
    "https://${GATEWAY_DOMAIN}/admin/api/health"
  echo
fi

case "${GATEWAY_DEPLOYMENT_MODE:-direct}" in
  direct)
    docker compose exec -T gateway \
      node /app/dist/operations/protocol-smoke.js \
      --url "https://${GATEWAY_DOMAIN}" \
      --connect-host caddy \
      --config /run/secrets/gateway_config
    ;;
  cloudflare-tunnel)
    docker compose run --rm --no-deps smoke \
      --url "https://${GATEWAY_DOMAIN}" \
      --config /run/secrets/gateway_config
    ;;
  *)
    echo "Unsupported GATEWAY_DEPLOYMENT_MODE." >&2
    exit 2
    ;;
esac

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
