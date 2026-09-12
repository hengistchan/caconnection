# Personal Communication Gateway — Phase 1 Android POC

This repository contains a deliberately small Android technical spike for one
question:

> Can a Xiaomi 17-class HyperOS device act as a reliable dual-SIM cellular SMS
> gateway?

The POC does not contain cloud transport, iOS, end-to-end encryption, AI, MCP,
contacts, MMS processing, or SMS history import.

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

## Data and safety boundaries

- No network permission is declared.
- No cloud endpoint exists.
- `READ_SMS` is not requested.
- SMS bodies and phone numbers are stored locally in the debug POC database.
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
