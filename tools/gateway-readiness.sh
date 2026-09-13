#!/usr/bin/env bash

set -u

PACKAGE="${PACKAGE:-com.caconnection.debug}"
EXPECTED_DEFAULT_SMS="${EXPECTED_DEFAULT_SMS:-com.android.mms}"
ASSUME_MANAGED_PROCESS=0
PASS_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0

usage() {
    cat <<'EOF'
Usage: tools/gateway-readiness.sh [--assume-managed-process]

Read-only deployment acceptance check for the connected Xiaomi Gateway.

Environment:
  ANDROID_SERIAL        Select a device when more than one is connected.
  PACKAGE               Gateway package (default: com.caconnection.debug).
  EXPECTED_DEFAULT_SMS  Expected unchanged SMS app (default: com.android.mms).

Exit codes:
  0  READY
  1  NOT READY
  2  Tool/device error
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --assume-managed-process)
            ASSUME_MANAGED_PROCESS=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if ! command -v adb >/dev/null 2>&1; then
    echo "ERROR: adb is not available." >&2
    exit 2
fi

ADB=(adb)
if [ -n "${ANDROID_SERIAL:-}" ]; then
    ADB+=( -s "$ANDROID_SERIAL" )
fi

device_state="$("${ADB[@]}" get-state 2>/dev/null || true)"
if [ "$device_state" != "device" ]; then
    echo "ERROR: no ready Android device selected (state: ${device_state:-none})." >&2
    exit 2
fi

pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '[PASS] %s: %s\n' "$1" "$2"
}

fail() {
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '[FAIL] %s: %s\n' "$1" "$2"
}

info() {
    INFO_COUNT=$((INFO_COUNT + 1))
    printf '[INFO] %s: %s\n' "$1" "$2"
}

check_equal() {
    label="$1"
    observed="$2"
    expected="$3"
    if [ "$observed" = "$expected" ]; then
        pass "$label" "$observed"
    else
        fail "$label" "observed=${observed:-missing}, expected=$expected"
    fi
}

check_runtime_permission() {
    permission="$1"
    if printf '%s\n' "$PACKAGE_DUMP" |
        grep -F "$permission: granted=true" >/dev/null; then
        pass "$permission" "granted"
    else
        fail "$permission" "not granted"
    fi
}

check_appop_allow() {
    op="$1"
    label="$2"
    output="$("${ADB[@]}" shell cmd appops get "$PACKAGE" "$op" 2>&1 | tr -d '\r')"
    if printf '%s\n' "$output" |
        grep -Eq ':[[:space:]]*allow([;[:space:]]|$)|Default mode:[[:space:]]*allow'; then
        pass "$label" "allow"
    else
        compact="$(printf '%s' "$output" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
        fail "$label" "${compact:-unavailable}"
    fi
}

echo "Gateway deployment readiness"
echo "============================"

PACKAGE_DUMP="$("${ADB[@]}" shell dumpsys package "$PACKAGE" 2>/dev/null | tr -d '\r')"
if ! printf '%s\n' "$PACKAGE_DUMP" | grep -F "Package [$PACKAGE]" >/dev/null; then
    echo "ERROR: package $PACKAGE is not installed." >&2
    exit 2
fi

version_name="$(printf '%s\n' "$PACKAGE_DUMP" |
    sed -n 's/^[[:space:]]*versionName=//p' | head -1)"
target_sdk="$(printf '%s\n' "$PACKAGE_DUMP" |
    sed -n 's/.*targetSdk=\([0-9][0-9]*\).*/\1/p' | head -1)"
user_zero="$(printf '%s\n' "$PACKAGE_DUMP" |
    grep -m1 'User 0:')"

check_equal "targetSdk" "$target_sdk" "37"
case "$version_name" in
    *target37*) pass "version" "$version_name" ;;
    *) fail "version" "${version_name:-missing}; expected target37 build" ;;
esac
if printf '%s\n' "$user_zero" | grep -F "stopped=false" >/dev/null; then
    pass "package stopped state" "false"
else
    fail "package stopped state" "true or unavailable"
fi

check_runtime_permission "android.permission.RECEIVE_SMS"
check_runtime_permission "android.permission.SEND_SMS"
check_runtime_permission "android.permission.READ_PHONE_STATE"

default_sms="$("${ADB[@]}" shell cmd role get-role-holders android.app.role.SMS 0 \
    2>/dev/null | tr -d '\r' | head -1)"
check_equal "default SMS package" "$default_sms" "$EXPECTED_DEFAULT_SMS"

ISUB_DUMP="$("${ADB[@]}" shell dumpsys isub 2>/dev/null | tr -d '\r')"
slot0="$(printf '%s\n' "$ISUB_DUMP" |
    sed -n 's/^[[:space:]]*Logical SIM slot 0: subId=\([-0-9][0-9]*\).*/\1/p' |
    head -1)"
slot1="$(printf '%s\n' "$ISUB_DUMP" |
    sed -n 's/^[[:space:]]*Logical SIM slot 1: subId=\([-0-9][0-9]*\).*/\1/p' |
    head -1)"
if [ -n "$slot0" ] && [ -n "$slot1" ] &&
    [ "$slot0" -ge 0 ] 2>/dev/null && [ "$slot1" -ge 0 ] 2>/dev/null &&
    [ "$slot0" != "$slot1" ]; then
    pass "dual-SIM mapping" "slot 0=subId $slot0; slot 1=subId $slot1"
else
    fail "dual-SIM mapping" "slot 0=${slot0:-missing}; slot 1=${slot1:-missing}"
fi

check_appop_allow "RECEIVE_SMS" "Android RECEIVE_SMS AppOp"
check_appop_allow "10008" "HyperOS auto-start / MIUIOP(10008)"
check_appop_allow "10018" "HyperOS notification SMS / MIUIOP(10018)"

pid="$("${ADB[@]}" shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r')"
info "current process" "${pid:-absent (not itself a failure)}"

enabled_notification_listeners="$("${ADB[@]}" shell settings get secure \
    enabled_notification_listeners 2>/dev/null | tr -d '\r')"
if printf '%s' "$enabled_notification_listeners" | grep -F "$PACKAGE/" >/dev/null; then
    info "notification listener access" "enabled"
else
    info "notification listener access" "not enabled (optional for SMS readiness)"
fi

if [ "$ASSUME_MANAGED_PROCESS" -eq 1 ]; then
    pass "managed process retention" "assumed by explicit deployment premise"
else
    fail "managed process retention" \
        "not asserted; rerun with --assume-managed-process only in a managed environment"
fi

if command -v sqlite3 >/dev/null 2>&1 &&
    "${ADB[@]}" shell run-as "$PACKAGE" test -f databases/gateway-poc.db \
        >/dev/null 2>&1; then
    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
    for name in gateway-poc.db gateway-poc.db-wal gateway-poc.db-shm; do
        if "${ADB[@]}" shell run-as "$PACKAGE" test -f "databases/$name" \
            >/dev/null 2>&1; then
            "${ADB[@]}" exec-out run-as "$PACKAGE" cat "databases/$name" \
                >"$temp_dir/$name" 2>/dev/null || true
        fi
    done
    latest="$(sqlite3 -readonly -separator '|' "$temp_dir/gateway-poc.db" \
        'SELECT receivedAt, persistedAt, resolvedSlotIndex,
         resolvedSubscriptionId, resolutionConfidence
         FROM incoming_sms_events ORDER BY persistedAt DESC LIMIT 1;' \
        2>/dev/null || true)"
    if [ -n "$latest" ]; then
        old_ifs="$IFS"
        IFS='|' read -r received persisted last_slot last_sub confidence <<EOF
$latest
EOF
        IFS="$old_ifs"
        delay=$((persisted - received))
        received_seconds=$((received / 1000))
        if command -v python3 >/dev/null 2>&1; then
            received_display="$(python3 - "$received_seconds" <<'PY'
from datetime import datetime
import sys

print(datetime.fromtimestamp(int(sys.argv[1])).astimezone().isoformat(timespec="seconds"))
PY
)"
        else
            received_display="$received"
        fi
        info "latest inbound evidence" \
            "received=$received_display; slot=$last_slot; subId=$last_sub; confidence=$confidence; persistDelay=${delay}ms"
    else
        info "latest inbound evidence" "no readable event"
    fi

    phase3_counts="$(sqlite3 -readonly -separator '|' "$temp_dir/gateway-poc.db" \
        'SELECT
         (SELECT COUNT(*) FROM notification_events),
         (SELECT COUNT(*) FROM call_events),
         (SELECT COUNT(*) FROM outbox_events
          WHERE payloadType IN ("NOTIFICATION", "CALL_STATE")
            AND status != "SUCCESS");' 2>/dev/null || true)"
    if [ -n "$phase3_counts" ]; then
        old_ifs="$IFS"
        IFS='|' read -r notification_count call_count phase3_not_success <<EOF
$phase3_counts
EOF
        IFS="$old_ifs"
        info "Phase 3 local evidence" \
            "notifications=$notification_count; calls=$call_count; outboxNotSuccess=$phase3_not_success"
    else
        info "Phase 3 local evidence" "schema or database evidence unavailable"
    fi
else
    info "latest inbound evidence" "database inspection unavailable"
fi

echo "----------------------------"
if [ "$FAIL_COUNT" -eq 0 ]; then
    echo "FINAL STATUS: READY"
    echo "This verdict relies on the explicit managed-process assumption."
    exit 0
else
    echo "FINAL STATUS: NOT READY"
    echo "$FAIL_COUNT required check(s) failed."
    exit 1
fi
