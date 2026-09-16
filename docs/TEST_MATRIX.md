# Phase 1 Physical Test Matrix

> Current build policy (2026-09-16): the project builds only the API 37
> `debug`/`release` variants. References to targetSdk 36 below are retained
> solely as historical evidence from earlier device runs; do not build or use
> an SDK 36 variant for future verification.

## Rules

1. Start with the API 37 `debug` build and do not request the default SMS role.
2. Record the exact device build, target SDK, SMS role state, SIM slot, runtime
   subscription ID, event timestamp, and resolver result for every run.
3. Use two controlled sender/destination numbers so the actual sending SIM can
   be independently verified.
4. Do not use `Force stop` as a background-reliability test. Use process death,
   task swipe-away, lock screen, and reboot as separate states.
5. Do not mark OTP tests complete with a hand-written message containing a code.
   Use a real standard OTP source.
6. Queue outbound tests from Admin or another authorized API client; the
   Android gateway app intentionally has no local compose/send UI.
7. Request the default SMS role only for T20 or when a Path A gate fails.
8. Restore the previous default SMS app after the test if the Xiaomi is not
   permanently dedicated to the gateway.

## Matrix

| ID | Scenario | Build / Role | Required evidence | Pass condition | Result |
|---|---|---|---|---|---|
| T01 | Launch app with two active SIMs | sdk36 / non-default | Dashboard + Diagnostics | two active subscriptions with distinct slots and IDs | PASS |
| T02 | SIM1 receives ordinary SMS ×10 | sdk36 / non-default | ten inbound records + sender confirmation | 10/10 received and SIM1 resolved | IN PROGRESS — 1/10 correct |
| T03 | SIM2 receives ordinary SMS ×10 | sdk36 / non-default | ten inbound records + sender confirmation | 10/10 received and SIM2 resolved | IN PROGRESS — 1/10 correct |
| T04 | SIM1 receives long Chinese SMS | sdk36 / non-default | one inbound event, part count | one correctly assembled body | PENDING |
| T05 | SIM2 receives long Chinese SMS | sdk36 / non-default | one inbound event, part count | one correctly assembled body | PENDING |
| T06 | SIM1 receives real OTP | sdk36 / non-default | source, sent time, persisted time | received within accepted latency | PASS — Xiaomi OTP, process absent, subId 1 / slot 0, persisted in 2.533 s |
| T07 | SIM2 receives real OTP | sdk36 / non-default | source, sent time, persisted time | received within accepted latency | PASS — Xiaomi OTP, process absent, subId 2 / slot 1, persisted in 1.634 s |
| T08 | targetSdk 36 OTP comparison | sdk36 / non-default | T06/T07 results | behavior recorded | PASS — both SIMs delivered promptly after `MIUIOP(10018)` was allowed |
| T09 | targetSdk 37 OTP comparison | sdk37 / non-default | same OTP class/source if possible | behavior recorded, delay classified | PASS — SIM1 Xiaomi OTP delivered in 2.309 s and SIM2 Juejin OTP in 2.269 s after re-allowing `MIUIOP(10018)` |
| T10 | Queue through Admin and send through SIM1 ×10 | sdk37 | Admin command + POC event + receiving phone/operator evidence | 10/10 actually sent from SIM1 | PENDING |
| T11 | Queue through Admin and send through SIM2 ×10 | sdk37 | Admin command + POC event + receiving phone/operator evidence | 10/10 actually sent from SIM2 | PENDING |
| T12 | Queue long SMS through Admin for SIM1 | sdk37 | multipart callbacks + received body | correct body and selected SIM | PENDING |
| T13 | Queue long SMS through Admin for SIM2 | sdk37 | multipart callbacks + received body | correct body and selected SIM | PENDING |
| T14 | Queue from Admin while airplane mode is on | sdk37 | outgoing command status/error | status becomes FAILED with radio/service error | PENDING |
| T15 | Queue from Admin with SIM1 out of service | sdk37 | outgoing command status/error | status becomes FAILED without SIM rerouting | PENDING |
| T16 | Swipe app from recent tasks, then receive | sdk37 | persisted event after reopen | event captured with correct SIM | PARTIAL PASS — process-absent receive passed for SIM1 and SIM2 after `MIUIOP(10018)` allow; literal swipe-away remains pending |
| T17 | Lock screen for 30 min, then receive | sdk37 | persisted event + timestamps | event captured promptly with correct SIM | PARTIAL PASS — targetSdk 37 SIM2 OTP passed while locked/dozing and process absent; 30-minute dwell not executed |
| T18 | Reboot, do not launch app, then receive | sdk37 | persisted event after later launch | event captured with correct SIM | PENDING |
| T19 | Repeat under HyperOS battery restrictions | sdk37 | settings snapshot + events | no foreground activity requirement | OUT OF CURRENT SCOPE — user directed the POC to assume a managed runtime that prevents background kill/freeze; observed `Greezer Denial` remains documented |
| T20 | Repeat SIM and OTP checks in default mode | sdk37 / default SMS | SMS_DELIVER extras, provider status, delay | reliable SIM evidence and prompt OTP | PENDING — fallback/comparison only; requires explicit approval to change default SMS app |

## Suggested execution sequence

### A. Initial install and probe

1. Install `app/build/outputs/apk/debug/app-debug.apk`.
2. Grant the four requested runtime permissions.
3. Keep the existing system SMS app as default.
4. Open Diagnostics and copy only non-sensitive device/subscription metadata
   into the behavior report.
5. Confirm that exactly two active subscriptions are shown.

### B. Path A receive/send

1. Execute T02–T05.
2. Compare the raw extra schema across all 22 messages.
3. Execute T10–T15 from Admin; do not look for a local Android composer.
4. Confirm actual source SIM on the receiving device; a successful callback is
   not sufficient proof of correct routing.

### C. HyperOS reliability

Execute T16–T19 without changing multiple background settings at once. Record
the exact state for auto-start, battery optimization, background restriction,
Wi-Fi, and mobile data. For the narrowed current POC, the remaining unmanaged
freeze/kill cases are deferred and replaced by the explicit managed-runtime
assumption documented below; this does not complete the production reliability
matrix.

### D. Current OTP verification

1. Confirm Diagnostics says `targetSdk 37`.
2. Execute T09 with the same OTP category/source where possible.
3. Treat T06–T08 targetSdk 36 results as historical comparison data only.

### E. Default SMS fallback

1. From Dashboard, request the default SMS role.
2. Confirm Diagnostics shows role held and this app as the default SMS package.
3. Execute T20.
4. Confirm each incoming event says `DEFAULT_SMS_DELIVER`, provider status
   `SAVED`, and has no duplicate corresponding `SMS_RECEIVED` event.

## Gate evaluation

- **Gate 1:** T01 passes.
- **Gate 2:** T02 and T03 total 20/20 correct. If not, proceed to Path B rather
  than failing the whole gateway.
- **Gate 3:** T10 and T11 total 20/20 route through the requested SIM.
- **Gate 4:** Current targetSdk 37 OTP behavior is recorded. Historical
  targetSdk 36 evidence may be used only as a comparison baseline. If the
  targetSdk 37 non-default path is delayed, T20 must establish whether default
  SMS mode restores acceptable latency.
- **Gate 5:** T16–T19 demonstrate no permanent foreground-activity dependency.

For the narrowed current POC, Gate 5 is not marked as passed. The user directed
evaluation to proceed under a managed runtime that prevents process
freeze/kill, so the observed `Greezer Denial` remains a production risk and
the literal swipe, 30-minute dwell, reboot, and restricted-background cases
remain incomplete.

## Executed OTP and process-absent evidence — 2026-09-12

All OTP bodies and originating service numbers must be redacted when copied
outside the local device. The local Room database was inspected with explicit
user authorization.

| Time | Build | SIM | Initial process | HyperOS notification-SMS op | Broadcast result | Persist delay | Outcome |
|---|---|---|---|---|---|---:|---|
| 12:36:05 | targetSdk 36 | SIM2, subId 2 / slot 1 | absent | allow | `DELIVERED`; process started for `SmsReceivedReceiver` | 1.634 s | PASS |
| 12:47:56 | targetSdk 36 | SIM1, subId 1 / slot 0 | absent | allow | `DELIVERED`; process started for `SmsReceivedReceiver` | 2.533 s | PASS |
| 12:49:46 | targetSdk 37 immediately after package update | SIM1, subId 1 / slot 0 | absent | reset to ignore by HyperOS permission reconciliation | `SKIPPED: MIUI Permission Skip` | N/A | FAIL; not an Android 17 delay result |
| 12:52:37 | targetSdk 37 after explicitly restoring op 10018 | SIM1, subId 1 / slot 0 | absent | allow | `DELIVERED`; process started for `SmsReceivedReceiver` | 2.309 s | PASS |
| 13:03:15 | targetSdk 37, locked/dozing | SIM2, subId 2 / slot 1 | absent | allow | `DELIVERED`; process started for `SmsReceivedReceiver` | 2.269 s | PASS |
| 13:06:45 | targetSdk 37, locked/dozing | SIM2, subId 2 / slot 1 | present but HyperOS-frozen | allow | `SKIPPED: Greezer Denial` | N/A | KNOWN RISK; excluded by managed-background assumption |

The targetSdk 37 passing sample establishes that this Xiaomi OTP class was not
subject to an observable multi-hour Android 17 delay on this build. It does not
prove that every OTP classification/source is exempt. The failed 12:49 sample
must not be counted as an Android 17 OTP-policy failure because HyperOS skipped
the receiver immediately after resetting its separate notification-SMS AppOp.

## HyperOS permission finding

For `SMS_RECEIVED` records whose intent contains:

```text
miui.intent.SERVICE_NUMBER=true
```

HyperOS checks the Xiaomi-specific AppOp:

```text
MIUIOP(10018) = OP_READ_NOTIFICATION_SMS
```

The manifest receiver is skipped with `MIUI Permission Skip` unless this AppOp
is in `allow` mode. `RECEIVE_SMS` and auto-start (`MIUIOP(10008)`) are
independent and were insufficient on their own.

An APK replacement from the targetSdk 36 build to the targetSdk 37 build
retained Room data and Android runtime permissions, but HyperOS permission
reconciliation changed `MIUIOP(10018)` back to `ignore`. Deployment and update
procedures therefore need an explicit post-install verification/provisioning
step for this AppOp.

## Current managed-background assumption

On 2026-09-12 the user directed the remaining POC evaluation to assume that
the deployed Gateway runtime prevents HyperOS from killing or freezing the
background process. Under that explicit assumption, the 13:06:45
`Greezer Denial` observation is a known deployment risk rather than a Phase 1
blocking gate.

This is an assumption, not evidence that unmanaged HyperOS background delivery
is reliable. A production deployment must implement and verify the process
retention mechanism separately.
