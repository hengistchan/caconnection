# Phase 3B — Incoming Caller Identity POC

Date: 2026-09-13

## Goal

Phase 3A proved per-SIM `RINGING` / `OFFHOOK` / `IDLE` state, but
`TelephonyCallback.CallStateListener` does not provide a caller address. Phase
3B adds the separately authorized Android call-screening role so future
incoming calls can produce:

```text
caller address
+ optional network-supplied display name
+ SIM attribution
+ allow-call response evidence
+ durable local Outbox event
```

Calls completed before this role was granted cannot be recovered.

## Authorization and safety boundary

The user explicitly required caller identity and manually granted
`ROLE_CALL_SCREENING` in the Android system UI.

The implementation:

- does not become the default dialer;
- does not change the default SMS application;
- does not request or declare `READ_CALL_LOG`;
- does not request or declare `READ_CONTACTS`;
- does not read historical calls;
- does not block, reject, silence, hide, or skip call-log recording;
- responds with `ALLOW` before asynchronous persistence;
- does not log `Call.Details`, caller address, or caller display name;
- keeps the full caller identity only in the local POC database, local Outbox,
  and local `Signals` UI;
- redacts caller identity from engineering reports.

Without `READ_CONTACTS`, the acceptance test uses a caller not saved in the
device contacts. Contact-name resolution remains outside this phase.

## Pipeline

```text
Incoming call
  -> GatewayCallScreeningService.onScreenCall
  -> respondToCall(ALLOW)
  -> capture caller address / presentation / verification status
  -> resolve SIM
  -> one Room transaction:
       CallIdentityEvent + OutboxEvent
  -> WorkManager
  -> MockTransport
  -> SUCCESS / RETRY / FAILED
```

The Outbox idempotency key is a full SHA-256 value prefixed with
`call_identity_`.

## SIM resolution

The preferred path is:

```text
PhoneAccountHandle.id
  -> exact match against active subscriptionId
  -> slotIndex
  -> PHONE_ACCOUNT_ID / HIGH
```

On the tested HyperOS build, `Call.Details.accountHandle` was `null` even
though the independent Telecom registry showed per-subscription phone accounts.
The initial device call therefore captured the caller address but left SIM
identity unresolved.

A conservative fallback was added:

```text
screening callback time
  -> exactly one recent RINGING/OFFHOOK per-subscription callback
  -> ACTIVE_CALL_STATE_CORRELATION / MEDIUM
```

The fallback never chooses between two candidate subscriptions and expires
state after five seconds. Persistence waits 300 ms after the immediate
allow-call response so an adjacent Telephony callback can arrive first.

## Automated verification

Both build variants verify:

- exact and unresolved phone-account mapping;
- no guessing for ambiguous account IDs;
- exactly-one-active-call correlation;
- ambiguity rejection and stale-state expiry;
- caller identity Outbox payload and SIM metadata;
- API 31 compatibility for the API 35+ Telecom call ID;
- existing notification, SMS, call-state, retry, and Outbox behavior.

The final clean verification command builds and tests both targetSdk variants
and runs both lint variants.

## Device evidence

Device:

```text
Xiaomi 17 Pro Max
Android 17 / API 37
HyperOS OS4.0.0.35.XPBCNXM
```

Role and application state:

```text
ROLE_CALL_SCREENING: com.caconnection.debug
default dialer:      com.android.contacts
default SMS:         com.android.mms
MIUIOP(10018):       allow
notification access: enabled
package stopped:     false
```

Final natural incoming-call event:

```text
observed:              2026-09-13 14:30:15.926 +08:00
caller address:        present, 11 characters [REDACTED]
address presentation:  allowed
display name:          absent
decision:              ALLOW
response latency:      0 ms
PhoneAccountHandle:    absent on this HyperOS callback
SIM resolution:        SIM1 / slot 0 / subId 1
resolver:              ACTIVE_CALL_STATE_CORRELATION / MEDIUM
call state:            RINGING -> IDLE
CALL_IDENTITY Outbox:  SUCCESS / retryCount 0
CALL_STATE Outbox:     2 x SUCCESS / retryCount 0
```

The local `Signals` page displays the full caller address. This report and
command output retain only presence and length.

## Conclusion

On the tested device, the gateway can capture a future incoming caller address,
allow the call without interference, correlate it to the receiving SIM, and
deliver both identity and call-state events through the local durable Outbox.

The remaining boundaries are:

- managed process retention is still an explicit deployment assumption;
- calls already completed before role grant are unavailable;
- withheld/private caller IDs cannot produce a number;
- contact-name coverage is not claimed because `READ_CONTACTS` was not
  requested;
- no real network transport exists in this POC.
