# Xiaomi 17 Pro Max Device Behavior Report

- Device build: **OS4.0.0.35.XPBCNXM**
- Android: **17 / API 37**
- Test date: **2026-09-12**
- SIM1 operator: **China Telecom / 中国电信**
- SIM2 operator: **China Unicom / 中国联通**

Do not record phone numbers, ICCIDs, IMSIs, full OTP values, or account names in
this report. Redact SMS bodies when attaching logs outside the local test
device.

## Active subscription mapping

| Logical line | Slot | Runtime subscription ID | Carrier | Result |
|---|---:|---:|---|---|
| Gateway Line A | 0 | 1 | 中国电信 | PASS |
| Gateway Line B | 1 | 2 | 中国联通 | PASS |

Subscription IDs are runtime identifiers and must not be treated as permanent
SIM identities.

## Path A — `SMS_RECEIVED`

### Observed extra schema

| Extra key | Runtime type | Example redacted value | Stable across tests? |
|---|---|---|---|
| `pdus` | `Array<byte[]>` | one PDU; bytes not copied | 6/6 delivered samples |
| `format` | `String` | `3gpp` | 6/6 |
| `subscription` | `Integer` | SIM1=`1`, SIM2=`2` | 6/6 |
| `android.telephony.extra.SUBSCRIPTION_INDEX` | `Integer` | SIM1=`1`, SIM2=`2` | 6/6 |
| `android.telephony.extra.SLOT_INDEX` | `Integer` | SIM1=`0`, SIM2=`1` | 6/6 |
| `phone` | `Integer` | SIM1=`0`, SIM2=`1` | 6/6 |
| `phone_id` | `Integer` | SIM1=`0`, SIM2=`1` | 6/6 |
| `slot_id` | `Integer` | SIM1=`0`, SIM2=`1` | 6/6 |
| `subscription_id` | `Integer` | SIM1=`1`, SIM2=`2` | 6/6 |
| `messageId` | `Long` | redacted | 6/6 |
| `msg_uri` | `String` | `content://sms/[redacted]` | 6/6 |
| `miui.intent.SERVICE_NUMBER` | `Boolean` | ordinary SMS=`false`, tested OTP=`true` | 6/6 |

### Resolution outcomes

| Scenario | Count | Correct SIM | Method | Confidence |
|---|---:|---:|---|---|
| SIM1 ordinary SMS | 10 | 1/1 so far | `OEM_SUBSCRIPTION_EXTRA` | HIGH |
| SIM2 ordinary SMS | 10 | 1/1 so far | `OEM_SUBSCRIPTION_EXTRA` | HIGH |
| SIM1 real OTP | 2 builds | 2/2 | `OEM_SUBSCRIPTION_EXTRA` | HIGH |
| SIM2 real OTP | 2 builds | 2/2 delivered samples | `OEM_SUBSCRIPTION_EXTRA` | HIGH |
| SIM1 long SMS | 1 | TBD | TBD | TBD |
| SIM2 long SMS | 1 | TBD | TBD | TBD |

## Path B — `SMS_DELIVER`

| Check | Result | Evidence |
|---|---|---|
| SMS role can be granted | PENDING | |
| `subscription` present | PENDING | |
| `slot` present | PENDING | |
| system SMS Provider write succeeds | PENDING | |
| one user notification appears | PENDING | |
| duplicate POC events avoided | PENDING | |

## Background and HyperOS behavior

| State | Incoming persisted? | Correct SIM? | Delay | Notes |
|---|---|---|---|---|
| Foreground | YES | YES | prompt | Ordinary SIM1/SIM2 smoke tests |
| Background | PENDING | PENDING | | |
| Screen locked 30 min | PARTIAL YES | YES | 2.269 s to Room | targetSdk 37 SIM2 passed while locked/dozing; 30-minute dwell not run |
| Recent task swiped away | PENDING | PENDING | | |
| App process absent | YES after op 10018 allow | YES for SIM1 and SIM2 | 1.6–2.5 s to Room | System started process specifically for `SmsReceivedReceiver` |
| Reboot, no app launch | PENDING | PENDING | | |
| Battery saver | PENDING | PENDING | | |
| Restricted background activity | PENDING | PENDING | | |
| Auto-start off/current default | NO | Broadcast extras were subId 2 / slot 1 | N/A | manifest receiver skipped by HyperOS policy |
| Auto-start on | NO for tested service/verification SMS | System broadcast extras remained subId 2 / slot 1 | N/A | User enabled at 12:22; second broadcast skipped at 12:24:31 |
| Auto-start on + `MIUIOP(10018)` allow | YES | YES | prompt | sdk36 SIM1/SIM2 and sdk37 SIM1 process-absent OTP passed |
| After APK replacement | NO until reprovisioned | System broadcast still had correct SIM extras | N/A | HyperOS reset `MIUIOP(10018)` to ignore during permission reconciliation |
| Process present but HyperOS-frozen | NO for observed follow-up service SMS | System broadcast extras still identified SIM2 | N/A | `Greezer Denial`; accepted as out of current POC scope under managed-background assumption |
| Wi-Fi and mobile data off | PENDING | PENDING | | |

Force-stop is not a reliability failure condition; Android intentionally stops
the package from receiving normal broadcasts until the user launches it again.

## OTP observations

| Build | SMS role | SIM | OTP source/type | Receive delay | Result |
|---|---|---|---|---:|---|
| targetSdk 36 | Non-default | SIM1 | Xiaomi account OTP, body redacted | 2.533 s to Room | PASS |
| targetSdk 36 | Non-default | SIM2 | Xiaomi account OTP, body redacted | 1.634 s to Room | PASS |
| targetSdk 37 | Non-default | SIM1 | Xiaomi account OTP immediately after APK update | receiver skipped immediately | FAIL — HyperOS had reset op 10018; not classified as Android OTP delay |
| targetSdk 37 | Non-default | SIM1 | Xiaomi account OTP after restoring op 10018 | 2.309 s to Room | PASS |
| targetSdk 37 | Non-default | SIM2 | Juejin OTP, body redacted | 2.269 s to Room | PASS while locked/dozing and initially process absent |
| targetSdk 37 | Default SMS | SIM1 | TBD | TBD | PENDING |
| targetSdk 37 | Default SMS | SIM2 | TBD | TBD | PENDING |

## Process-absent failure evidence

At **2026-09-12 12:18:28**, while the app process was absent:

```text
action = android.provider.Telephony.SMS_RECEIVED
subscription = 2
slot = 1
miui.intent.SERVICE_NUMBER = true
receiver = com.caconnection.telephony.inbound.SmsReceivedReceiver
delivery = SKIPPED
reason = skipped by policy at enqueue: MIUI Permission Skip
```

The package was enabled, `stopped=false`, and had `RECEIVE_SMS` granted. No
event was added to Room. This test must be repeated after an explicitly
authorized HyperOS auto-start/background-policy change.

The user manually enabled the HyperOS auto-start switch at **2026-09-12
12:22**. Post-change baseline:

```text
MIUIOP(10008) = allow
process = absent
package stopped = false
receiver = enabled
incoming event count = 2
default SMS package = com.android.mms
```

At **12:24:31**, a second SIM2 service/verification SMS arrived with auto-start
still allowed. HyperOS again recorded:

```text
receiver = com.caconnection.telephony.inbound.SmsReceivedReceiver
delivery = SKIPPED
reason = skipped by policy at enqueue: MIUI Permission Skip
```

The HyperOS app permission page showed SMS access as `Always allow`. The system
default SMS package received the corresponding `SMS_DELIVER`. Auto-start alone
is therefore insufficient for the tested Path A OTP/service-message scenario.

## Root cause and successful retest

Framework inspection established the exact skip condition. For
`SMS_RECEIVED`, AppOp 16, and intents carrying
`miui.intent.SERVICE_NUMBER=true`, HyperOS additionally checks:

```text
MIUIOP(10018) = OP_READ_NOTIFICATION_SMS
```

If its mode is not `allow`, `BroadcastQueueModernStubImpl.isSKipNotifySms`
returns true and the outer broadcast policy records `MIUI Permission Skip`.
The method does not inspect process state, task state, or auto-start AppOp
10008.

After the user authorized changing this permission, op 10018 was changed from
`ignore` to `allow`.

At **12:36:05**, while the targetSdk 36 process was absent, a real SIM2 Xiaomi
OTP arrived. At 12:36:06 Android started the process for
`SmsReceivedReceiver`; the event persisted with subId 2 / slot 1 and HIGH
confidence, 1.634 seconds after the SMS timestamp.

At **12:47:56**, after another verified process-absent baseline, a real SIM1
Xiaomi OTP arrived. Android started the process for the manifest receiver and
persisted subId 1 / slot 0 with HIGH confidence in 2.533 seconds.

The APK was then replaced with the targetSdk 37 variant while preserving app
data. HyperOS asynchronously reconciled the package permissions and reset
`MIUIOP(10018)` to `ignore`. Consequently, the SIM1 OTP at **12:49:46** was
immediately skipped with `MIUI Permission Skip`.

After op 10018 was explicitly restored to `allow` and remained allowed through
a 20-second reconciliation wait, a new SIM1 Xiaomi OTP at **12:52:37** started
the targetSdk 37 process for `SmsReceivedReceiver` and persisted in 2.309
seconds. No multi-hour OTP delay was observed for this source/classification.

At **13:03:15**, with the phone locked/dozing and the targetSdk 37 Gateway
process absent, a SIM2 Juejin OTP started the process for
`SmsReceivedReceiver`, resolved subId 2 / slot 1 with HIGH confidence, and
persisted in 2.269 seconds.

At **13:06:45**, another SIM2 service-number SMS arrived after HyperOS had
frozen the now-existing background process. The receiver was skipped with
`Greezer Denial` and no Room row was added. The user subsequently directed the
POC to assume a managed runtime that prevents background kill/freeze. This
observation remains a production risk and is not reclassified as a pass.

## Final observed behavior

```text
SMS_RECEIVED raw extras:
Xiaomi supplied consistent subscription and slot aliases on all six
successfully delivered samples. Real OTP samples were marked
miui.intent.SERVICE_NUMBER=true.

SMS_DELIVER raw extras:
TBD

Recommended integration mode:
Path A is the provisional mode under two deployment prerequisites:
OP_READ_NOTIFICATION_SMS is provisioned and verified after every install or
update, and the managed Gateway runtime prevents HyperOS process freeze/kill.
Final full-matrix completion still requires long-run/reboot evidence, long
messages, ordinary-message accumulation, and outbound-routing evidence.
```
