# Phase 4B — Encrypted Local Transport

Date: 2026-09-13

## Result

Phase 4B passes its local cryptographic and physical-device acceptance gates:

```text
Xiaomi Android gateway
  -> durable Room Outbox
  -> schema-v2 AES-256-GCM payload
  -> HMAC-SHA256 authenticated HTTPS
  -> pinned Mac receiver certificate
  -> encrypted SQLite envelope
  -> loopback-only decrypted viewer
```

The final targetSdk 37 APK was installed on the physical Xiaomi device. A
natural SIM1 SMS, deterministic self-tests, receiver-outage recovery, and
tampered-ciphertext handling were verified end to end.

No paid SMS, cloud service, default-SMS change, default-dialer change, contact
permission, call-log permission, or battery/background policy change was used.
Sensitive values remain redacted from this report.

## Protocol v2

The outer event envelope retains the routing fields required for delivery and
diagnostics:

```text
schemaVersion = 2
deliveryId
sourceEventId
eventType
createdAt
subscriptionId
slotIndex
```

The payload field contains only:

```text
algorithm = AES-256-GCM
nonceBase64
ciphertextBase64
```

The 256-bit payload key is derived from the per-device shared secret with
HKDF-SHA256:

```text
salt = device ID
info = caconnection/payload-encryption/v1
length = 32 bytes
```

The authenticated additional data binds the ciphertext to schema version,
delivery ID, source event ID, event type, creation time, SIM attribution, and
device ID. Changing any of those values invalidates the AES-GCM tag.

Each request continues to carry:

```text
X-Gateway-Device
X-Gateway-Timestamp
X-Gateway-Nonce
X-Gateway-Signature
Idempotency-Key
```

The HMAC-SHA256 signature covers:

```text
timestamp
request nonce
device ID
idempotency key
SHA-256(exact encrypted request body)
```

The Python and Kotlin implementations share a deterministic golden vector
that verifies the exact serialized request bytes, AES-GCM ciphertext, HKDF
result compatibility, and HMAC signature.

## HTTPS and certificate pinning

The receiver exposes:

```text
HTTPS ingestion: https://192.168.0.126:8787
Local viewer:    http://127.0.0.1:8788
```

The Android client requires HTTPS in both debug and release builds. The debug
cleartext opt-in was removed. The client validates the leaf certificate
validity period and requires its SHA-256 DER digest to match the configured
pin. Normal HTTPS hostname verification remains active.

The local setup tool:

- creates a 2048-bit RSA self-signed certificate with LAN-IP, loopback-IP, and
  localhost subject alternative names;
- writes the certificate, private key, shared secret, and database outside
  Git;
- preserves existing credentials by default;
- detects an expired certificate or a certificate that does not cover the
  requested LAN IP;
- requires explicit `--rotate-certificate` use before replacing a certificate,
  because rotation also requires updating the Android pin.

The live certificate was valid during acceptance and expires on 2027-09-13.

## Receiver and storage behavior

The receiver authenticates the exact ciphertext before decrypting it, then
performs AES-GCM verification before insertion. New schema-v1 plaintext
ingestion is rejected; schema-v1 support remains only for one-time migration
of existing Phase 4A database rows.

The ten existing Phase 4A rows were migrated to schema v2. At the final storage
audit:

```text
receiver rows:          16
schema-v2 rows:         16
schema-v1 rows:          0
```

SQLite main, WAL, and SHM files were scanned for known plaintext payload field
markers, including SMS-body and caller-address fields. None were found.

Malformed Base64, invalid nonce length, invalid JSON, and AES-GCM tag failure
are mapped to the same generic response:

```text
400 {"error":"invalid encrypted payload"}
```

The handler does not expose cryptographic exception details and does not store
the rejected event.

The viewer remains bound to loopback only. It decrypts payloads in memory on
the trusted Mac when the user opens the local viewer.

## Automated verification

Python tests:

```text
13/13 passed
```

Coverage includes:

- AES-256-GCM round trip;
- ciphertext hiding the plaintext fixture;
- Android/Python deterministic protocol-v2 golden vector;
- tampered ciphertext and generic failure behavior;
- trusted and untrusted TLS certificates;
- correct HMAC and invalid HMAC;
- expired request timestamp;
- request-nonce replay;
- idempotent duplicate with a fresh nonce;
- schema-v1 network rejection;
- legacy database migration;
- migration/storage idempotency.

Android verification:

```text
targetSdk 36: 53/53 unit tests passed
targetSdk 37: 53/53 unit tests passed
targetSdk 36 APK: assembled
targetSdk 37 APK: assembled
targetSdk 36 lint: passed
targetSdk 37 lint: passed
```

The Android tests cover HTTPS-only configuration, certificate-pin validation,
exact encrypted-envelope serialization, payload decryption, protocol-compatible
HMAC, HTTP status mapping, and all previous SMS/call/notification/Outbox
behavior.

## Physical-device self-test

The final targetSdk 37 APK retained the existing application data and
permissions. Private transport configuration was updated without printing the
shared secret:

```text
endpoint scheme:        HTTPS
device credential:      matches receiver
certificate pin:        matches receiver
transport enabled:      yes
```

The final deterministic Android self-test produced:

```text
Android Outbox:         SUCCESS
retry count:            0
last error:             clear
receiver inserts:       1
schema version:         2
stored payload shape:   ciphertext only
```

This verifies the physical Android implementation, local Wi-Fi path, pinned
certificate, HMAC authentication, AES-GCM interoperability, receiver
decryption, encrypted storage, and acknowledgement handling.

## Receiver-outage recovery

The receiver was stopped before a new deterministic self-test:

```text
receiver unavailable
Android Outbox:         RETRY
transport error:        classified as retryable
```

After restarting the receiver, no manual resend was issued:

```text
Android Outbox:         SUCCESS
retry count:            3
last error:             clear
receiver inserts:       1
```

This confirms that Phase 4B retains the Phase 4A durable retry behavior.

## Live tampered-ciphertext test

A request with a valid device identity and HMAC but a modified AES-GCM
ciphertext was submitted to the live HTTPS receiver:

```text
response:               400
error text:             generic
service health after:   200
database rows added:    0
```

## Natural SIM1 SMS acceptance

A natural SMS was sent to SIM1 after the final APK installation:

```text
Android reception:      present
SIM slot:               0 / SIM1
subscription ID:        1
resolution method:      OEM_SUBSCRIPTION_EXTRA
resolution confidence:  HIGH
body:                   present, 3 characters [REDACTED]
sender:                 present [REDACTED]
Android Outbox:         SUCCESS
retry count:            0
last error:             clear
Mac transport latency:  245 ms
server schema:          2
stored payload:         ciphertext only
```

A metadata-only notification event was also delivered without storing its
title or body.

## Post-install Android state

HyperOS temporarily reset `MIUIOP(10018)` during delayed package
reconciliation. Only that operation was restored to its pre-install state and
was rechecked after 20 seconds:

```text
MIUIOP(10018):          allow
default SMS:            com.android.mms
default dialer:         com.android.contacts
call-screening role:    com.caconnection.debug
notification listener: enabled
```

No other AppOps, roles, defaults, or background/battery settings were changed.

## Security boundary

Phase 4B protects event payloads against LAN observation and against accidental
plaintext persistence in the receiver database. It does not hide outer routing
metadata.

The trusted Mac possesses the same per-device secret needed to authenticate
and decrypt payloads. Therefore this is **not** a cloud-blind end-to-end
encryption design. An untrusted relay would require a separate recipient
public/private-key design in which only the eventual iPhone or web client
holds the decryption private key.

The Android POC currently stores its shared secret in application-private
preferences rather than hardware-backed Android Keystore storage. Keystore
integration and independent encryption/authentication key rotation remain
future hardening work.

## Conclusion

Phase 4B is complete for the trusted local-Mac architecture:

- the final APK is installed on the physical phone;
- natural SIM1 SMS capture is preserved;
- all payloads cross the LAN through pinned HTTPS;
- payloads are AES-256-GCM encrypted before transmission;
- HMAC, timestamp, nonce, and idempotency protections remain active;
- the receiver stores ciphertext and decrypts only for the loopback viewer;
- outage recovery and tamper rejection pass;
- default applications and approved Android roles remain unchanged.

Cloud relay architecture, recipient-only decryption, Android Keystore
hardening, certificate/secret rotation UX, and unmanaged long-duration
HyperOS background survival are intentionally outside this phase.
