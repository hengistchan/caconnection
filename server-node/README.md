# CA Connection Gateway — Node.js/TypeScript

Production Node.js implementation of the CA Connection Gateway. It preserves
the Android device protocol, Admin API, encrypted SQLite data, and deployment
paths of the Python implementation.

## Current status

- Complete Fastify API surface for device ingestion, Admin reads/writes,
  pairing, OTP claims, groups, audit records, and outbound SMS commands.
- HMAC authentication is verified over the exact received request bytes.
- AES-256-GCM/HKDF crypto remains cross-language compatible.
- Event nonce, event row, device state, outbound status, and retention writes
  are committed in one SQLite transaction.
- Notification events fan out through a durable per-channel outbox to Feishu,
  Generic Webhook, and Bark providers without exposing provider credentials to
  the Admin API.
- Config loading is strict and fail-fast; production settings come from the
  existing `config.json`.
- Docker, Compose, backup, restore, health checks, and protocol smoke tooling
  use the Node image.
- Host-side provisioning and cutover acceptance remain small Python utilities;
  the retired Python Gateway runtime is no longer part of the repository.

## Commands

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Run locally:

```bash
CONFIG_PATH=/absolute/path/to/config.json \
DATABASE_PATH=/absolute/path/to/gateway.db \
npm start
```

`CONFIG_PATH` is required. The service does not start with an unreadable or
invalid config.

## Architecture

```text
src/
├── app.ts                         composition root and HTTP-wide policy
├── main.ts                        process lifecycle and graceful shutdown
├── auth/                          API authentication and rate limiting
├── config/                        constants and strict runtime config
├── crypto/                        HMAC, HKDF, AES-GCM, OTP extraction
├── database/                      schema and transaction primitives
├── http/                          raw JSON capture and query validation
├── operations/                    backup, restore, protocol smoke CLI tools
├── notifications/                 event normalization and provider adapters
├── protocol/                      encrypted envelope validation
├── repositories/                  SQLite persistence boundaries, including device state
├── routes/                        thin HTTP adapters
└── services/                      device authentication and event transactions
```

## Runtime paths

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | required | Existing Gateway `config.json` |
| `DATABASE_PATH` | `./data/gateway.db` | SQLite database |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8787` | Listen port |

Proxy trust, retention, OTP age, rate limits, pairing settings, and concurrency
are read from `config.json.server`; they are not shadowed by ad-hoc environment
variables.

## Notification channels

`config.json.notifications.channels` accepts `FEISHU`, `WEBHOOK`, and `BARK`
entries. Operational enablement, `REDACTED`/`FULL` privacy mode, and subscribed
event types are stored separately in SQLite and managed through
`/v1/notification-channels`.

Supported event names are `sms.received`, `call.ringing`, `call.missed`,
`call.ended`, and `notification.received`. Each event/channel pair has its own
outbox row, retry state, and delivery result.

## Protocol compatibility tests

`test/fixtures/golden-vectors.json` is a frozen migration fixture that verifies
HKDF, AES-GCM, HMAC signatures, and OTP extraction. Repository and HTTP tests
now exercise the Node implementation directly.

```bash
npm run test:compat
```
