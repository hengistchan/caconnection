# ADR-001: Android Gateway SMS Integration Mode

- Status: **Provisional Path A under managed-background assumption**
- Date: **2026-09-12**
- Target device: **Xiaomi 17 Pro Max / Android 17 / HyperOS OS4.0**

## Context

The gateway must receive SMS while backgrounded or not running, identify the
physical SIM that received each message, send through an explicitly selected
SIM, and receive OTP messages without unacceptable policy delay.

For a non-default app, `SMS_RECEIVED` provides the message PDUs but the
subscription/slot extras are not treated by this POC as a portable platform
contract. The Xiaomi broadcast may contain useful values, but they are
classified as OEM behavior and cross-checked against the active subscription
list.

For the default SMS app, `SMS_DELIVER` is the authoritative delivery path. The
default app must also persist messages to the system SMS Provider and provide
user notification behavior.

Android 17 introduces standard OTP SMS protection for apps targeting API 37.
This can make the non-default observer path unsuitable for an OTP gateway even
when ordinary SMS delivery works.

## Option A — Non-default SMS observer

### Benefits

- Minimal impact on the phone's system SMS configuration.
- No ownership of the system SMS inbox.
- Adequate if Xiaomi consistently supplies correct SIM metadata and OTP
  messages arrive promptly.

### Risks

- SIM metadata on `SMS_RECEIVED` may be OEM-specific.
- Android 17 standard OTP protection may delay access for an untrusted app
  targeting API 37.
- Reliability must be proven under HyperOS background and battery policies.

## Option B — Default SMS handler

### Benefits

- Authoritative `SMS_DELIVER` path.
- Stronger subscription/slot evidence.
- Expected exemption path for standard OTP SMS protection.
- Correct ownership model for SMS Provider persistence and notification.

### Costs

- The POC becomes the device's system default SMS application.
- It must fulfill default-handler responsibilities even though MMS and a full
  consumer conversation UI are outside Phase 1.
- The user must explicitly grant and later revoke the SMS role when testing.

## Decision rule

Choose **Option A** only if all of the following are demonstrated:

1. SIM1 and SIM2 inbound tests are 20/20 correct.
2. Raw extra keys/values remain stable across foreground, lock screen, process
   death, recent-task removal, and reboot tests.
3. `targetSdk 37` real OTP messages arrive within the acceptable latency.
4. HyperOS background tests do not require a permanently foreground activity.

Choose **Option B** if any of these occur:

- inbound SIM cannot be resolved with high confidence;
- standard OTP is delayed under `targetSdk 37`;
- `SMS_RECEIVED` is unreliable under the target HyperOS conditions.

## Current decision

**Use Path A for the current POC under a managed-background assumption; final
production decision remains pending.**

On this exact Xiaomi build, non-default `SMS_RECEIVED` supplied consistent
subscription and slot aliases, and process-absent real OTP delivery passed on
both SIMs for targetSdk 36 and targetSdk 37. The two tested targetSdk 37 OTP
sources were delivered promptly rather than after a multi-hour delay.

However, HyperOS requires its hidden `OP_READ_NOTIFICATION_SMS`
(`MIUIOP(10018)`) AppOp for messages tagged
`miui.intent.SERVICE_NUMBER=true`. Auto-start and Android `RECEIVE_SMS` do not
replace this permission. More importantly, an APK replacement caused HyperOS
permission reconciliation to reset this AppOp from allow to ignore, producing
an immediate `MIUI Permission Skip` until the op was restored.

TargetSdk 37 real OTP delivery passed promptly for both SIM1 and SIM2 after op
10018 was restored. The SIM2 sample also passed from a locked/dozing,
process-absent state.

A later service-number SMS was skipped with `Greezer Denial` after HyperOS
froze the background process. The user directed the current POC to assume that
the deployed Gateway environment prevents background process freeze/kill.
Under that explicit premise, Option A is the provisional integration mode.

Option A still requires reliable provisioning and post-update verification for
op 10018, plus a separately verified production process-retention mechanism.
This assumption does not constitute proof of unmanaged HyperOS reliability.
Long messages and full inbound/outbound routing gates remain incomplete.
Option B remains the fallback and has not been activated because changing the
system default SMS application requires separate explicit approval.
