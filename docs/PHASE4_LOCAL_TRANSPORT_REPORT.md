# Phase 4A — Authenticated Local Network Transport

Date: 2026-09-13

## Goal

Move real gateway events off the Android device for the first time without
buying or deploying a cloud service:

```text
Xiaomi Gateway
  -> local Wi-Fi
  -> Mac receiver
  -> local SQLite
  -> local browser viewer
```

The implementation transmits incoming SMS, notification metadata, call state,
and incoming caller identity. Reports remain redacted even though the local
receiver stores the event payload required by the gateway.

## Protocol

Each Outbox row becomes schema version 1:

```text
deliveryId
sourceEventId
eventType
createdAt
subscriptionId
slotIndex
payload
```

Requests include:

```text
X-Gateway-Device
X-Gateway-Timestamp
X-Gateway-Nonce
X-Gateway-Signature
Idempotency-Key
```

The signature is HMAC-SHA256 over:

```text
timestamp
nonce
device ID
idempotency key
SHA-256(request body)
```

The receiver rejects unknown devices, invalid signatures, timestamps outside a
five-minute window, replayed nonces, unsupported schema versions, malformed
payloads, and bodies larger than 1 MiB.

Server-side uniqueness on `(device_id, idempotency_key)` means a retry with a
fresh nonce returns success without inserting a duplicate event.

## Local receiver

The receiver uses only the Python standard library:

- `ThreadingHTTPServer`;
- HMAC and SHA-256 verification;
- SQLite WAL storage;
- replay nonce table;
- local browser viewer;
- local clear-data action.

The ingestion endpoint listens on the LAN and requires authentication. The
viewer and clear-data endpoint reject non-loopback clients, so event content is
viewable only from the Mac.

Runtime state is excluded from Git:

```text
server/config.json
server/data/
```

The generated configuration file was verified as mode `0600`, and the secret
was never printed or committed.

## Android transport

`OutboxProcessor` now passes a typed `TransportEvent` rather than only payload
text. `GatewayTransportFactory` selects:

- `AuthenticatedHttpTransport` when enabled and fully configured;
- `MockTransport` otherwise.

HTTP response handling:

- 2xx: success;
- 408, 425, 429, and 5xx: retryable;
- other 4xx: permanent failure;
- transport exception: retryable without logging endpoint or payload.

The app includes a `Transport` page for endpoint, device ID, hidden shared
secret, enable/disable state, mode diagnostics, and a self-test action.

## Security boundary

The Phase 4A device test uses:

```text
http://192.168.0.126:8787
```

Cleartext is enabled only by the debug manifest. HMAC proves request integrity
and device possession of the secret, but **does not provide confidentiality**:
a LAN observer could read SMS or caller payloads. This is acceptable only for
the scoped local POC.

Release builds do not opt into cleartext and configuration validation requires
HTTPS. A production/cloud phase must add TLS certificate validation and should
add payload-level end-to-end encryption before carrying real sensitive data
over an untrusted network.

## Automated verification

Python receiver tests cover:

- stable and body-sensitive signatures;
- idempotent insertion with fresh nonces;
- replayed nonce rejection;
- envelope schema validation.

Android tests cover:

- envelope serialization;
- protocol-compatible HMAC;
- required request headers;
- success, retryable, and permanent HTTP status mapping;
- transport exceptions without endpoint leakage;
- all earlier SMS, notification, call, caller-ID, and Outbox behavior.

The final gate runs:

```text
Python receiver: 4/4 tests passed
targetSdk 36: 52/52 unit tests passed
targetSdk 37: 52/52 unit tests passed
targetSdk 36 APK: assembled
targetSdk 37 APK: assembled
targetSdk 36 lint: 0 errors, 4 dependency-version warnings
targetSdk 37 lint: 0 errors, 4 dependency-version warnings
```

## Protocol integration evidence

Mac-local signed protocol test:

```text
first request:                  201 accepted
same nonce replay:              409 rejected
same idempotency/new nonce:     200 duplicate, no new row
health endpoint:                200
viewer from LAN address:        403
```

## Device self-test and outage recovery

Authenticated Android self-test:

```text
device -> Mac latency: 242 ms
device Outbox: SUCCESS
retryCount: 0
server inserts: 1
```

Receiver outage test:

```text
receiver stopped
new Outbox event retained
observed RETRY with Transport exception
receiver restarted
same Outbox automatically recovered
final status: SUCCESS
final retryCount: 5
server inserts for recovered event: 1
```

## Natural SMS evidence

Natural SMS received on 2026-09-13:

```text
SMS timestamp:              14:59:56 +08:00
SIM:                        SIM1 / slot 0 / subId 1
resolver:                   OEM_SUBSCRIPTION_EXTRA / HIGH
body:                       present, 39 characters [REDACTED]
Android persist delay:      2367 ms
Android Outbox:             SUCCESS / retryCount 0
Mac received:               14:59:58.550 +08:00
device event -> Mac:        180 ms
notification metadata:      one event, 164 ms
```

The server had two rows for this natural event: one `INCOMING_SMS` and one
metadata-only `NOTIFICATION`, with two distinct idempotency keys.

## Natural incoming-call evidence

SIM1 network event:

```text
RINGING received by Mac:      15:02:03.476 / 177 ms
CALL_IDENTITY received:       15:02:03.975 / 221 ms
IDLE received:                15:02:05.802 / 205 ms
caller address:               present, 11 characters [REDACTED]
decision:                     ALLOW / 0 ms response
resolver:                     ACTIVE_CALL_STATE_CORRELATION / MEDIUM
all Outbox rows:              SUCCESS / retryCount 0
```

SIM2 network event:

```text
RINGING received by Mac:      15:03:30.978 / 176 ms
CALL_IDENTITY received:       15:03:31.358 / 177 ms
IDLE received:                15:03:32.880 / 164 ms
caller address:               present, 11 characters [REDACTED]
decision:                     ALLOW
resolver:                     ACTIVE_CALL_STATE_CORRELATION / MEDIUM
all Outbox rows:              SUCCESS / retryCount 0
```

Each call produced three distinct server idempotency keys and no duplicate
rows.

## Conclusion

Phase 4A passes under the existing managed-process premise:

- real SMS and call events leave the Android device;
- signed requests cross the local Wi-Fi network;
- the Mac authenticates, de-duplicates, stores, and displays them;
- receiver downtime produces durable retry and automatic recovery;
- SIM1 and SIM2 caller identity/state are preserved end to end;
- no paid SMS or cloud service was used.

The next production step is not cloud deployment by itself. It is replacing
debug cleartext HTTP with TLS plus payload-level encryption, followed by an
explicit decision about hosting and iPhone/web consumption.
