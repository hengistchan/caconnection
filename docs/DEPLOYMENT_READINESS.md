# Gateway Deployment Readiness

This check is deliberately split into an on-device local check and an external
HyperOS acceptance check.

## Why two checks are required

The app can safely inspect its target SDK, Android runtime permissions, active
subscriptions, whether the Gateway itself holds the default-SMS role, and the
latest locally persisted inbound event. HyperOS may hide the exact default SMS
package name from the app, so the external check verifies that exact package.
It cannot rely on a supported Android API to inspect Xiaomi's hidden
`MIUIOP(10008)` and `MIUIOP(10018)` AppOps.

The app therefore reports:

```text
LOCAL STATUS: READY
```

only for locally observable prerequisites. This is not the final deployment
verdict. The external script is authoritative for the complete:

```text
FINAL STATUS: READY
```

## Read-only acceptance check

Connect the dedicated Xiaomi device with ADB enabled, then run:

```bash
./tools/gateway-readiness.sh --assume-managed-process
```

The flag records the explicit Phase 1 premise that the production environment
prevents the Gateway process from being killed or frozen. It does not test or
implement process retention.

The script checks:

- targetSdk 37 and a non-empty installed version identity;
- package is not in Android's stopped state;
- `RECEIVE_SMS`, `SEND_SMS`, and `READ_PHONE_STATE`;
- the original `com.android.mms` default-SMS package remains selected;
- two distinct active subscriptions map to slots 0 and 1;
- Android `RECEIVE_SMS` AppOp;
- HyperOS auto-start, `MIUIOP(10008)`;
- HyperOS service/notification SMS access, `MIUIOP(10018)`;
- current process state as information only;
- latest local inbound timestamp, SIM mapping, confidence, and persistence
  delay when the debug Room database can be read.

The script never prints phone numbers, ICCIDs, IMSIs, senders, message bodies,
or OTP values.

Exit code `0` means `READY`, `1` means `NOT READY`, and `2` means the tool or
selected device is unavailable.

## Required post-update sequence

An APK replacement was observed to reset `MIUIOP(10018)` asynchronously.
Every deployment or update must therefore use this sequence:

1. Install or update the targetSdk 37 APK.
2. Wait for HyperOS permission reconciliation to finish.
3. Run the readiness script.
4. If `MIUIOP(10018)` is not `allow`, provision it through the approved
   managed-device process.
5. Run the readiness script again and accept the deployment only when it
   reports `FINAL STATUS: READY`.

The script is read-only and intentionally does not repair permissions.

## Verified device run — 2026-09-12

The completed tool was exercised against the connected Xiaomi 17 Pro Max:

1. Before replacement install, the script reported `FINAL STATUS: READY`.
2. The newly built targetSdk 37 APK was installed over the existing package.
3. After a 25-second reconciliation wait, the script reported
   `FINAL STATUS: NOT READY` because `MIUIOP(10018)` had changed to `ignore`.
4. The previously authorized permission was restored to `allow`.
5. Checks at 0, 10, and 30 seconds confirmed it remained allowed.
6. The final complete run reported `FINAL STATUS: READY`.

The on-device Dashboard also reported `LOCAL STATUS: READY`, two distinct SIMs,
all required runtime permissions, Gateway `ROLE_SMS=false`, and the latest
redacted inbound evidence for SIM2 with HIGH resolver confidence.
