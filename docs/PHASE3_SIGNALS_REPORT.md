# Phase 3A — Notification and Call Signal POC

Date: 2026-09-13

## Scope

This slice answers two additional gateway questions without adding a network
transport or changing the default SMS/dialer roles:

1. Can the Android gateway observe selected application notifications after
   the user grants notification access?
2. Can it observe and attribute call-state transitions to SIM1 or SIM2?

The Phase 1 managed-process premise still applies. In particular, call-state
listeners are runtime registrations and this POC does not claim unmanaged
HyperOS process survival.

## Implemented pipeline

```text
Notification access granted by user
  -> source package allowlist
  -> NotificationListenerService
  -> metadata-only NotificationEvent + OutboxEvent in one Room transaction
  -> WorkManager
  -> MockTransport

READ_PHONE_STATE
  -> one TelephonyManager created for each active subscriptionId
  -> one TelephonyCallback.CallStateListener per subscription
  -> RINGING / OFFHOOK / IDLE CallEvent + OutboxEvent in one Room transaction
  -> WorkManager
  -> MockTransport
```

## Notification privacy boundary

The listener may inspect title/text only long enough to record:

- whether a title was exposed;
- whether text was exposed;
- title and text character counts.

The database and Outbox do **not** contain:

- title or body values;
- OTP values;
- actions;
- arbitrary notification extras;
- contact or account identifiers extracted from content.

The source package, notification ID, channel, category, timestamps, and a
SHA-256 digest of the system notification key are retained for diagnostics.
The digest is not derived from title/body content.

The allowlist is deny-by-default. An empty allowlist captures nothing, and the
gateway's own package is always excluded to prevent feedback loops.
Foreground-service notifications and group summaries are excluded, and
identical callbacks inside a five-second window are collapsed. This prevents
OEM helper notifications and immediate duplicate updates from being mistaken
for separate user messages. A removal event is retained only when the same
listener process previously accepted its posted event, which also prevents
stripped OEM foreground-service removals from re-entering the event stream.

Android 15 and later can redact OTP-sensitive notification content before
delivery to an untrusted notification listener. Therefore notification
listening must not replace the verified raw SMS receiver for OTP capture.

## Call privacy and role boundary

The POC records only:

- `subscriptionId`;
- `slotIndex`;
- `RINGING`, `OFFHOOK`, or `IDLE`;
- observation time;
- a locally generated call-session identifier.

The initial idle callback is suppressed, duplicate states are suppressed, and
one session ID links the ringing/answered/idle sequence. An initial non-idle
snapshot is retained so process startup during an active call remains visible.

Caller number and contact identity are not requested or stored. Reliable caller
details would require the separate `ROLE_CALL_SCREENING` /
`CallScreeningService` path. That role is outside Phase 3A and must not be
requested without separate user authorization.

## Local verification

Both `targetSdk 36` and `targetSdk 37` variants must pass:

```text
unit tests
APK assembly
Android lint
Room schema export
```

Device closure requires:

1. install/update the `targetSdk 37` APK and verify the v2-to-v3 Room migration;
2. manually grant notification access;
3. save at least one source package in the allowlist;
4. receive one natural notification from that source;
5. confirm exactly one linked metadata event and successful Outbox row;
6. place one incoming call to SIM1 and one to SIM2;
7. confirm each call produces the expected per-SIM state sequence and successful
   Outbox rows;
8. confirm no notification body, OTP, or caller number is present in the new
   tables or Outbox payloads;
9. re-run the existing gateway readiness check and re-provision
   `MIUIOP(10018)` if the APK replacement reset it.

## Current status

Implementation, automated verification, and the scoped physical-device matrix
are complete.

### Automated verification

```text
targetSdk 36: 41/41 unit tests passed
targetSdk 37: 41/41 unit tests passed
targetSdk 36 APK: assembled
targetSdk 37 APK: assembled
targetSdk 36 lint: 0 errors, 3 dependency-version warnings
targetSdk 37 lint: 0 errors, 3 dependency-version warnings
Room schema: version 3 exported
```

The installation migrated the existing device database from version 2 to
version 3 without losing the four pre-existing incoming SMS rows or five
pre-existing Outbox rows.

### Natural notification evidence

Final-build event on 2026-09-13:

```text
SMS received:              13:55:41 +08:00
SIM attribution:           SIM1 / slot 0 / subId 1
resolver:                  OEM_SUBSCRIPTION_EXTRA / HIGH
SMS timestamp -> Room:     1923 ms
SMS body length:           58 characters
notification observed:     13:55:43 +08:00
notification source:       com.android.mms
notification category:     msg
title exposed:             yes (16 characters)
text exposed:              yes (58 characters)
user-facing events:        1
foreground-service noise:  0
SMS Outbox:                SUCCESS / retryCount 0
Notification Outbox:       SUCCESS / retryCount 0
```

The notification table and its Outbox payload contain no title/body value.
Only the metadata and lengths above are persisted.

### Per-SIM incoming-call evidence

Final-build events on 2026-09-13:

```text
SIM2 / slot 1 / subId 2
13:59:32 RINGING
13:59:39 IDLE
one session ID
both Outbox rows SUCCESS / retryCount 0

SIM1 / slot 0 / subId 1
14:02:36 RINGING
14:02:49 IDLE
one session ID
both Outbox rows SUCCESS / retryCount 0
```

The call table schema contains only event/session IDs, subscription, slot,
state, timestamp, and initial-snapshot state. Inspection also confirmed no
caller identity field in any `CALL_STATE` Outbox payload.

### Final device readiness

The post-test read-only acceptance check returned `READY`:

```text
targetSdk 37
package stopped=false
RECEIVE_SMS / SEND_SMS / READ_PHONE_STATE granted
default SMS package remains com.android.mms
slot 0=subId 1; slot 1=subId 2
MIUIOP(10008)=allow
MIUIOP(10018)=allow
notification listener access enabled
Phase 3 Outbox rows not SUCCESS=0
```

This verdict still relies on the user's explicit managed-process premise. It
does not prove unmanaged HyperOS process survival.
