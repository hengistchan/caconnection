#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

PACKAGE="${1:-com.caconnection.gateway}"
DOCUMENT="runtime/android-provisioning.json"
REMOTE="/sdcard/Android/data/${PACKAGE}/files/gateway-provisioning.json"

test -f "$DOCUMENT"

DEVICE_COUNT="$(adb devices | awk '$2 == "device" { count += 1 } END { print count + 0 }')"
if [ "$DEVICE_COUNT" -ne 1 ]; then
  echo "Exactly one authorized Android device must be connected" >&2
  exit 2
fi

adb shell pm path "$PACKAGE" >/dev/null
adb shell monkey -p "$PACKAGE" 1 >/dev/null 2>&1
adb shell mkdir -p "/sdcard/Android/data/${PACKAGE}/files"
cleanup() {
  adb shell unlink "$REMOTE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
adb push "$DOCUMENT" "$REMOTE" >/dev/null 2>&1
RESULT="$(
  adb shell am broadcast --receiver-foreground \
    -a com.caconnection.action.IMPORT_GATEWAY_PROVISIONING \
    -n "${PACKAGE}/com.caconnection.transport.GatewayProvisioningReceiver"
)"
echo "$RESULT" | grep -q "data=\"provisioned\""
echo "Android gateway provisioning imported successfully."
