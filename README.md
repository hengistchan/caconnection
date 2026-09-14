# Personal Communication Gateway — Android POC

This repository contains a deliberately small Android technical spike for one
question:

> Can a Xiaomi 17-class HyperOS device act as a reliable dual-SIM cellular SMS
> gateway?

The POC does not contain iOS, cloud-blind end-to-end encryption, AI, MCP,
contacts, MMS processing, or SMS history import. Phase 4 added an authenticated
and encrypted local-LAN receiver running on the development Mac. Phase 5 adds a
production Linux deployment in which the Android phone connects directly to a
public HTTPS server; the Mac is no longer part of the runtime architecture.

## Implemented capabilities

- Runtime dual-SIM discovery with `subscriptionId` and `slotIndex`.
- Two build variants compiled against Android API 37:
  - `sdk36Debug`: `targetSdk 36`
  - `sdk37Debug`: `targetSdk 37`
- Path A inbound receiver using `SMS_RECEIVED`.
- Raw inbound extra key/type capture without persisting raw PDU bytes.
- Explicit resolver classifications:
  - `OEM_SUBSCRIPTION_EXTRA`
  - `OEM_SLOT_EXTRA`
  - `DEFAULT_SMS_DELIVER`
  - `UNRESOLVED`
- Multipart SMS assembly using `Telephony.Sms.Intents.getMessagesFromIntent`.
- Path B default-SMS-role qualification and role request UI.
- `SMS_DELIVER` handling, SMS Provider persistence, and notification while the
  app holds the default SMS role.
- Explicit per-subscription sending through
  `SmsManager.createForSubscriptionId`.
- Multipart sending with per-part sent and delivery callbacks.
- Local Room event store containing subscription, inbound, and outbound POC
  records.
- Engineering UI with Dashboard, Incoming, Send, and Diagnostics pages.
- Battery optimization, background restriction, standby bucket, permission,
  default SMS role, build, and device diagnostics.
- Transactional local Outbox creation for each newly persisted inbound SMS.
- SHA-256 idempotency keys that distinguish the two physical SIM lines.
- WorkManager scheduling, retry state, exponential backoff, stale-attempt
  recovery, process-start recovery, and indefinite retry for temporary
  network/server failures with a five-minute maximum interval.
- A no-network Mock Transport and local Outbox self-test.
- User-granted `NotificationListenerService` capture behind an explicit source
  package allowlist.
- Metadata-only notification persistence and Outbox payloads; notification
  title/body values are never stored.
- Runtime `TelephonyCallback.CallStateListener` registration for each active
  SIM subscription.
- Per-SIM `RINGING` / `OFFHOOK` / `IDLE` events and local Outbox delivery,
  without caller number collection or a call-screening role.
- Optional user-granted call-screening role for future incoming caller
  addresses. The service always allows calls and never rejects, silences,
  hides, or removes them from the system call log.
- Direct SIM resolution from `PhoneAccountHandle.id` plus a conservative
  fallback that correlates the screening callback with exactly one recent
  per-SIM active-call callback.
- A schema-versioned envelope with AES-256-GCM payload encryption,
  HMAC-SHA256 authentication, HTTPS, and leaf-certificate pinning.
- A Python local receiver with replay protection, server-side idempotency,
  encrypted-payload SQLite persistence, and a localhost-only browser viewer.
- Automatic Outbox retry and recovery when the local receiver is unavailable.
- Android Keystore protection for the gateway shared secret, including
  migration away from the legacy plaintext preference.
- A production release package (`com.caconnection.gateway`) that can be
  installed beside the earlier POC package and is signed only with explicitly
  supplied production signing credentials.
- A production Linux receiver behind Caddy with automatic public TLS,
  container restart, private backend networking, read-only/non-root container
  hardening, request concurrency limits, and per-IP/per-device/per-client rate
  limits.
- Authenticated `GET /v1/messages` and atomic one-time
  `POST /v1/otp/claim` APIs.
- Thirty-day configurable retention, encrypted SQLite storage, verified
  backup/export and atomic restore tooling, liveness/readiness/version probes,
  and an encrypted signed deployment smoke test.

## Data and safety boundaries

- `INTERNET` is declared for encrypted local and production transport.
- Debug and release builds require HTTPS; neither manifest opts into cleartext
  traffic.
- Payloads are encrypted with AES-256-GCM before transmission and remain
  encrypted in the receiver database. Routing metadata such as event type,
  timestamp, and SIM attribution remains visible.
- Receiver credentials, API bearer tokens, Android provisioning files,
  signing material, and database files are excluded from Git.
- The Phase 4 local viewer and clear-data API accept only loopback clients on
  the Mac. The production viewer is disabled.
- The trusted receiver possesses the shared secret and decrypts payloads in
  memory for authenticated message and OTP responses. This is not a
  cloud-blind relay design.
- On Android, the shared secret is encrypted with an app-private Android
  Keystore AES-GCM key. The key remains available to background workers and is
  not exportable through normal app storage.
- `READ_SMS` is not requested.
- SMS bodies and phone numbers are stored locally in the debug POC database.
- Notification content is not stored. Only source package, timing, channel,
  category, visibility flags, and content lengths are retained.
- Phase 3A call-state events contain state and SIM attribution only.
- After the user explicitly grants the Phase 3B call-screening role, incoming
  caller address and any network-supplied display name are sensitive local POC
  data and are copied into the local Outbox. They are never written to logs or
  engineering reports.
- Call history and contacts are not read.
- The local Outbox contains a second serialized copy of an inbound event until
  it is cleared. The UI clear operation deletes incoming, outgoing, and Outbox
  data together.
- Android backup and device-transfer backup are disabled for the application.
- The Diagnostics page exposes intent extra names, types, and safe scalar
  values, but does not stringify raw SMS PDU byte arrays.
- Default SMS mode writes received/sent messages to the system SMS Provider,
  as required of the active default SMS handler.

## Build

The project requires Android SDK Platform 37.0, Android Gradle Plugin 9.4, and
Gradle 9.6.

```bash
./gradlew clean test assembleSdk36Debug assembleSdk37Debug \
  lintSdk36Debug lintSdk37Debug
```

Generated APKs:

```text
app/build/outputs/apk/sdk36/debug/app-sdk36-debug.apk
app/build/outputs/apk/sdk37/debug/app-sdk37-debug.apk
```

Both debug variants use application ID:

```text
com.caconnection.debug
```

Installing one variant replaces the other. Existing local POC data is retained
across replacement installs unless the app is uninstalled or its data is
cleared.

Production release builds use application ID:

```text
com.caconnection.gateway
```

Production signing values are accepted only through the
`CACONNECTION_RELEASE_*` environment variables. Build and verify the signed
APK with:

```bash
./tools/build-production-apk.sh
```

## Xiaomi / HyperOS installation

HyperOS may block ADB installation until the user explicitly allows USB
installation on the phone. Do not bypass this protection. After accepting the
phone-side prompt, install the desired APK from Android Studio or with ADB.

The app then requests:

```text
RECEIVE_SMS
SEND_SMS
READ_PHONE_STATE
POST_NOTIFICATIONS (Android 13+)
```

`RECEIVE_MMS` and `RECEIVE_WAP_PUSH` are declared only for Path B system-role
qualification and WAP delivery routing. They are not requested by the initial
Path A permission flow, and Phase 1 does not parse or persist MMS payloads.

Default SMS mode is a separate, explicit user action from the Dashboard.

## Test execution

Use [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md) as the authoritative physical
test protocol. Record results in:

- [docs/CAPABILITY_REPORT.md](docs/CAPABILITY_REPORT.md)
- [docs/DEVICE_BEHAVIOR_REPORT.md](docs/DEVICE_BEHAVIOR_REPORT.md)

The architecture decision is tracked in:

- [docs/ADR-001-android-gateway-sms-mode.md](docs/ADR-001-android-gateway-sms-mode.md)

Do not mark a gate as passed from an emulator, an injected broadcast, or a
single successful SMS. The required evidence is the full physical matrix on
the target Xiaomi device and its real SIMs/operators.

## Deployment readiness

The Dashboard now reports locally observable Path A readiness and the latest
non-sensitive inbound evidence. Xiaomi's hidden notification-SMS and
auto-start AppOps require the separate read-only acceptance check:

```bash
./tools/gateway-readiness.sh --assume-managed-process
```

See [docs/DEPLOYMENT_READINESS.md](docs/DEPLOYMENT_READINESS.md) for the
post-install/update acceptance procedure and the boundary between verified
device state and the explicit managed-process assumption.

## Phase 2 local Outbox

The first Phase 2 slice is deliberately local-only:

```text
Inbound receiver
  -> one Room transaction: IncomingSmsEvent + OutboxEvent
  -> WorkManager
  -> Mock Transport
  -> SUCCESS / RETRY / FAILED persisted in Room
```

At the time of the Phase 2 report, no `INTERNET` permission was declared and
the Mock Transport performed no network request. The historical report remains
the evidence for that phase; Phase 4 can now select a real Transport.

See [docs/PHASE2_OUTBOX_REPORT.md](docs/PHASE2_OUTBOX_REPORT.md) for the design,
failure handling, and verified device evidence.

## Phase 3A local notification and call signals

The `Signals` page exposes two additional local-only paths:

```text
Allowed app notification
  -> NotificationListenerService
  -> metadata-only NotificationEvent + OutboxEvent
  -> Mock Transport

Per-SIM TelephonyCallback
  -> RINGING / OFFHOOK / IDLE CallEvent + OutboxEvent
  -> Mock Transport
```

Notification access must be granted manually in Android settings. An empty
source allowlist captures nothing. The call path uses the existing
`READ_PHONE_STATE` permission and retains the explicit managed-process
assumption because `TelephonyCallback` is a runtime registration.

Android may redact sensitive notification content before it reaches an
untrusted notification listener. Raw SMS reception remains the OTP path.

See [docs/PHASE3_SIGNALS_REPORT.md](docs/PHASE3_SIGNALS_REPORT.md).

## Phase 3B incoming caller identity

The optional caller-ID path is:

```text
User grants ROLE_CALL_SCREENING
  -> CallScreeningService
  -> immediate ALLOW response
  -> caller address + SIM resolution
  -> CallIdentityEvent + OutboxEvent
  -> active Transport
```

The app remains neither the default dialer nor the default SMS app. It does not
declare `READ_CALL_LOG` or `READ_CONTACTS`, and it does not use the screening
role to block calls. Full caller addresses are visible only in the local
`Signals` page and local POC storage.

See [docs/PHASE3B_CALLER_ID_REPORT.md](docs/PHASE3B_CALLER_ID_REPORT.md).

## Phase 4B encrypted local transport

When configured from the `Transport` page, WorkManager sends a unified
schema-versioned envelope to the Mac receiver:

```text
Room Outbox
  -> AES-256-GCM encrypted payload
  -> HMAC-SHA256 signed request
  -> pinned-certificate HTTPS
  -> local Wi-Fi
  -> Python receiver
  -> certificate + timestamp + nonce + signature verification
  -> encrypted SQLite idempotent insert
  -> localhost-only browser viewer
```

If transport is disabled or incomplete, the application falls back to
`MockTransport`. Local runtime credentials live in ignored
`server/config.json` and Android private preferences.

Start the local receiver:

```bash
python3 -m pip install -r server/requirements.txt
python3 server/setup_local.py
python3 server/gateway_server.py
```

Then open:

```text
http://127.0.0.1:8788/
```

See:

- [docs/PHASE4_LOCAL_TRANSPORT_REPORT.md](docs/PHASE4_LOCAL_TRANSPORT_REPORT.md)
  for the Phase 4A authenticated HTTP baseline;
- [docs/PHASE4B_ENCRYPTED_TRANSPORT_REPORT.md](docs/PHASE4B_ENCRYPTED_TRANSPORT_REPORT.md)
  for the encrypted HTTPS implementation and physical-device acceptance.

## Phase 5 production server

The production runtime is:

```text
Xiaomi Android gateway
  -> Room Outbox
  -> AES-256-GCM payload
  -> HMAC-authenticated HTTPS
  -> Caddy public TLS endpoint
  -> private Gateway API container
  -> encrypted SQLite
  -> bearer-authenticated message / one-time OTP API
```

The backend container is not published on the host. Caddy exposes only TCP
80/443 and UDP 443. Public certificates use normal Android system-CA
validation, so certificate renewal does not require phone reprovisioning.

Deployment files are under `server/deploy/`. Start with:

```bash
cd server/deploy
python3 ../production_preflight.py --domain gateway.example.com
python3 ../setup_production.py --domain gateway.example.com
python3 ../production_preflight.py \
  --domain gateway.example.com \
  --require-runtime
./deploy.sh
./check.sh
```

`check.sh` verifies public TLS liveness/readiness/version endpoints and sends
one real signed, encrypted event through Caddy to the private receiver.

Do not provision the phone until those checks pass. Then install the signed
release package and use `provision_android.sh`. Re-run the HyperOS readiness
check after every package replacement because HyperOS may reset
`MIUIOP(10018)`.

See:

- [server/deploy/README.md](server/deploy/README.md) for the operating runbook;
- [server/openapi.yaml](server/openapi.yaml) for the API contract;
- [docs/PHASE5_PRODUCTION_SERVER_REPORT.md](docs/PHASE5_PRODUCTION_SERVER_REPORT.md)
  for the implementation and acceptance evidence.
