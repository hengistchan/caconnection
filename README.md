# CA Connection

> A dual-SIM cellular SMS gateway for Xiaomi / HyperOS devices, with a production
> Linux backend, admin console, and multi-channel notification delivery.

[![CI](https://github.com/hengistchan/caconnection/actions/workflows/ci.yml/badge.svg)](https://github.com/hengistchan/caconnection/actions/workflows/ci.yml)

---

## Table of Contents · 目录

| | Section · 章节 |
|---|---|
| 1 | [Overview · 项目概览](#overview) |
| 2 | [Architecture · 架构](#architecture) |
| 3 | [Capabilities · 功能](#capabilities) |
| 4 | [Security & Privacy · 安全与隐私](#security--privacy) |
| 5 | [Build · 构建](#build) |
| 6 | [Installation · 安装](#installation) |
| 7 | [Deployment · 部署](#deployment) |
| 8 | [Admin UI · 管理界面](#admin-ui) |
| 9 | [Testing · 测试](#testing) |
| 10 | [Project Phases · 项目阶段](#project-phases) |

---

## Overview

**CA Connection** turns a Xiaomi 17-class HyperOS phone into a reliable dual-SIM
SMS gateway. The phone captures SMS, notifications, and call events, encrypts
them end-to-end, and delivers them to a self-hosted server. Clients consume
messages and claim OTP codes through authenticated APIs.

```
┌─────────────────┐       HTTPS + AES-256-GCM       ┌──────────────────┐
│  Android Phone  │ ──────────────────────────────► │  Linux Server    │
│  (Dual-SIM GW)  │                                 │  Caddy + Gateway │
└─────────────────┘                                 └────────┬─────────┘
                                                             │
                                                    ┌────────▼─────────┐
                                                    │  Admin UI / API  │
                                                    │  Feishu / Bark / │
                                                    │  Webhook         │
                                                    └──────────────────┘
```

### What's in this repo

| Directory | Description |
|-----------|-------------|
| `app/` | Android gateway app (Kotlin / Java, API 37) |
| `server-node/` | Node.js Gateway API (Fastify + SQLite) |
| `admin/` | Nuxt 4 admin console |
| `server/` | Python deployment, provisioning & ops tooling |
| `docs/` | Phase reports, architecture decisions, test matrix |

---

## Architecture

### Data flow

```
Inbound SMS / Notification / Call event
  → Room transaction (event + Outbox)
  → WorkManager (retry, backoff, recovery)
  → AES-256-GCM encrypted envelope
  → HMAC-SHA256 signed HTTPS request
  → Caddy TLS termination
  → Gateway API container (private network)
  → Encrypted SQLite
  → Authenticated REST API / Admin UI / Notification channels
```

### Routing identity

| Concept | Role |
|---------|------|
| `(deviceId, slotIndex)` | Stable route key for multi-gateway isolation |
| `subscriptionId` | Telemetry only — never used for routing |
| `PhoneAccountHandle.id` | Direct SIM resolution for call screening |

### Edge modes

| Mode | Description |
|------|-------------|
| **Direct Caddy** | Public TLS with automatic system-CA certificates |
| **Cloudflare Tunnel** | Named tunnel, no host ports published by Gateway stack |

---

## Capabilities

### Android gateway

| Area | Details |
|------|---------|
| **Dual-SIM** | Runtime discovery, per-subscription sending via `SmsManager.createForSubscriptionId` |
| **Inbound SMS** | `SMS_RECEIVED` + `SMS_DELIVER` (default SMS role), multipart assembly |
| **Outbound SMS** | Authenticated remote commands, per-part sent/delivery callbacks, dedup |
| **Notifications** | User-granted `NotificationListenerService` with explicit package allowlist |
| **Call events** | Per-SIM `RINGING` / `OFFHOOK` / `IDLE` via `TelephonyCallback` |
| **Caller ID** | Optional `ROLE_CALL_SCREENING` — always allows calls, never blocks |
| **Outbox** | Transactional creation, WorkManager retry with exponential backoff, boot/package-replace recovery |
| **Security** | Android Keystore for shared secret, AES-256-GCM envelope, certificate pinning |
| **Diagnostics** | Connection tests (DNS, TCP, TLS, liveness, readiness), build & device info |

### Server & API

| Area | Details |
|------|---------|
| **Transport** | HTTPS via Caddy, HMAC-signed requests, replay protection |
| **Storage** | Encrypted SQLite, 30-day configurable retention |
| **APIs** | `GET /v1/messages`, `GET /v1/notifications`, `POST /v1/otp/claim` (atomic) |
| **Isolation** | Per-client `allowedDeviceIds`, per-device outbound selection, group-scoped filters |
| **Lifecycle** | Reversible retirement, irreversible purge, secret rotation with re-encryption |
| **Ops** | Backup/export + atomic restore, liveness/readiness/version probes, smoke tests |
| **Notifications** | Feishu, Bark, Generic Webhook — async delivery with bounded retries |

---

## Security & Privacy

| Boundary | Policy |
|----------|--------|
| **Transport** | HTTPS required in debug and release; no cleartext traffic |
| **Encryption** | AES-256-GCM payloads, HMAC-SHA256 request signing, leaf-cert pinning |
| **Secrets** | Excluded from Git; Android Keystore-encrypted; never returned by APIs |
| **SMS** | `READ_SMS` not requested; bodies and numbers stored only in local POC DB |
| **Notifications** | Title/body captured only for explicitly allowlisted packages |
| **Call events** | State + SIM attribution only; caller address only with call-screening role |
| **Contacts** | Not read. Call history is not read. |
| **Backup** | Android backup and device-transfer backup disabled |
| **Production viewer** | Disabled; Phase 4 local viewer accepted loopback clients only |

---

## Build

**Requirements:** Android SDK Platform 37, AGP 9.4, Gradle 9.6, JDK 17.

```bash
./gradlew clean testDebugUnitTest assembleDebug lintDebug
```

| Build type | Application ID | Output |
|------------|---------------|--------|
| Debug | `com.caconnection.debug` | `app/build/outputs/apk/debug/app-debug.apk` |
| Production | `com.caconnection.gateway` | Via `./tools/build-production-apk.sh` |

Production signing uses `CACONNECTION_RELEASE_*` environment variables only.
Existing POC data is retained across replacement installs.

---

## Installation

### Xiaomi / HyperOS

HyperOS blocks ADB installs until you allow USB installation on the phone.
Accept the on-device prompt — do not bypass this protection.

### Permissions requested at runtime

| Permission | Purpose |
|------------|---------|
| `RECEIVE_SMS` | Inbound SMS capture |
| `SEND_SMS` | Remote command execution |
| `READ_PHONE_STATE` | SIM discovery & call state |
| `POST_NOTIFICATIONS` | Android 13+ notifications |

`RECEIVE_MMS` and `RECEIVE_WAP_PUSH` are declared only for Path B system-role
qualification — not requested in the initial permission flow.

Default SMS mode is enabled separately from the Dashboard.

### Readiness check

```bash
./tools/gateway-readiness.sh --assume-managed-process
```

Re-run after every package replacement — HyperOS may reset `MIUIOP(10018)`.

---

## Deployment

```bash
cd server/deploy

# Preflight & setup
python3 ../production_preflight.py --domain gateway.example.com
python3 ../setup_production.py --domain gateway.example.com
python3 ../production_preflight.py --domain gateway.example.com --require-runtime

# Deploy & verify
./deploy.sh
./check.sh
```

`check.sh` verifies public TLS endpoints and sends one real signed, encrypted
event through Caddy. **Do not provision the phone until these checks pass.**

For Cloudflare Tunnel mode, add `--deployment-mode cloudflare-tunnel`, run
`server/setup_cloudflare.py`, and use `COMPOSE_FILE=compose.cloudflare.yaml`.

See [`server/deploy/README.md`](server/deploy/README.md) for the full runbook
and [`server/openapi.yaml`](server/openapi.yaml) for the API contract.

---

## Admin UI

**Live:** https://gateway.example.com/admin/

### Features

| Feature | Description |
|---------|-------------|
| **Multi-language** | Simplified Chinese (default) & English |
| **Gateway Status** | Real-time health, readiness, version monitoring |
| **Communication Workspace** | Browse SMS & notifications with type/Gateway/SIM/source/date filters |
| **Device Workspace** | Secret rotation, pairing, retirement/restore/purge, groups |
| **Remote SMS** | Send after explicit Gateway + SIM selection — no auto-routing |
| **OTP Claim** | One-time code extraction with confirmation |
| **Privacy** | Content hidden by default |
| **Notification Channels** | Feishu / Bark / Webhook with per-channel subscriptions & retry |

### Security

- Gateway API token never reaches the browser (server-side Nitro proxy)
- scrypt-hashed admin password with random salt
- Rate-limited login (5 attempts / 15 min per IP)
- HMAC-signed HttpOnly session cookies with persistent logout revocation
- HSTS, CSP, X-Frame-Options, no-referrer headers
- `Cache-Control: no-store` on all sensitive responses

### Quick setup

```bash
# Generate admin credentials
python3 server/setup_admin.py --runtime-dir server/deploy/runtime

# Configure Feishu (keeps webhook out of shell history)
python3 server/setup_feishu.py \
  --runtime-dir server/deploy/runtime \
  --webhook-url-file /secure/path/feishu-webhook.txt

# Set permissions & deploy
python3 server/prepare_runtime_permissions.py \
  --runtime-dir server/deploy/runtime \
  --deployment-mode cloudflare-tunnel \
  --enable-admin

cd server/deploy
docker compose -f compose.cloudflare.yaml up -d
```

Webhook templates: `{{event.id}}`, `{{event.type}}`, `{{event.timestamp}}`,
`{{device.id}}`, `{{device.name}}`, `{{data.from}}`, `{{data.contactName}}`,
`{{data.body}}`.

Bark supports official and self-hosted servers, with optional sustained ringing
for calls. Retry schedule: 5s → 30s → 2m, then stop after 4th failure.

See [`admin/README.md`](admin/README.md) for details.

---

## Testing

Use [`docs/TEST_MATRIX.md`](docs/TEST_MATRIX.md) as the authoritative physical
test protocol. Record results in:

- [`docs/CAPABILITY_REPORT.md`](docs/CAPABILITY_REPORT.md)
- [`docs/DEVICE_BEHAVIOR_REPORT.md`](docs/DEVICE_BEHAVIOR_REPORT.md)

> **Gate rule:** Do not mark a gate as passed from an emulator, injected
> broadcast, or a single SMS. The required evidence is the full physical matrix
> on the target Xiaomi device with real SIMs/operators.

Architecture decision: [`docs/ADR-001-android-gateway-sms-mode.md`](docs/ADR-001-android-gateway-sms-mode.md)

---

## Project Phases

| Phase | Scope | Report |
|-------|-------|--------|
| **1** | Dual-SIM SMS gateway POC | — |
| **2** | Local Outbox with WorkManager retry | [PHASE2](docs/PHASE2_OUTBOX_REPORT.md) |
| **3A** | Notification & call signals | [PHASE3](docs/PHASE3_SIGNALS_REPORT.md) |
| **3B** | Incoming caller identity | [PHASE3B](docs/PHASE3B_CALLER_ID_REPORT.md) |
| **4A** | Authenticated HTTP transport | [PHASE4](docs/PHASE4_LOCAL_TRANSPORT_REPORT.md) |
| **4B** | Encrypted HTTPS local transport | [PHASE4B](docs/PHASE4B_ENCRYPTED_TRANSPORT_REPORT.md) |
| **5** | Production Linux server | [PHASE5](docs/PHASE5_PRODUCTION_SERVER_REPORT.md) |

Architecture & routing contract: [`docs/MULTI_GATEWAY_ARCHITECTURE.md`](docs/MULTI_GATEWAY_ARCHITECTURE.md)
Deployment readiness: [`docs/DEPLOYMENT_READINESS.md`](docs/DEPLOYMENT_READINESS.md)
