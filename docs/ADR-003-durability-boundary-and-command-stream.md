# ADR-003: Durability boundary and push-assisted command delivery

- Status: Accepted
- Date: 2026-09-25

## Context

CA Connection has two reliability classes of code, and HyperOS (and stock
Android) treats them completely differently:

**Passive capability** — driven by broadcasts the OS delivers regardless of
whether our process is alive: `SMS_RECEIVED` / `SMS_DELIVER`, `BOOT_COMPLETED`,
`CallScreeningService`, `NotificationListenerService`. These survive the main
process being killed: the manifest receiver runs in `:sms_receiver` and stages
durable state.

**Active capability** — things that only happen if our process is alive and
scheduled: remote-command polling, heartbeat, network monitoring, the
foreground service. HyperOS killing or freezing the main process degrades
these heavily, no matter how aggressively `START_STICKY`, `AlarmManager`,
`USER_PRESENT` or wake locks are used.

Two concrete pressures followed from this:

1. `GatewayRuntime.reconcile()` and the keepalive stack were growing into a
   "survive HyperOS" centre of gravity, mixing correctness concerns with
   scheduling concerns.
2. Remote commands were polled every 15 s via self-requeuing WorkManager
   work. WorkManager is not a 15-second scheduler — on HyperOS the effective
   interval is far worse — and if `iPhone/Web → Android → SMS` becomes a
   product capability, 15-second (or worse) latency is not enough.

## Decision 1 — Split the architecture into Durable Core and Availability Layer

```
        Availability Layer
   FGS · command stream · WorkManager
   AlarmManager · NetworkCallback
   BOOT_COMPLETED · USER_PRESENT
   HyperOS autostart / battery exemption
                │
                │  may only affect latency and visibility
                ▼
          Durable Core
   SMS receiver → spool → Room → outbox
          correctness lives here
```

- **Durable Core** guarantees *no loss*: `IncomingSmsProcessor` phases,
  `SmsSpoolStore`, `SmsSpoolRecovery`, Room + outbox transactions, at-least-once
  upload with server-side idempotent consume. Every durability claim in code
  must name the write that backs it (spool stage, synchronous Room fallback,
  WorkManager persistence) and degrade loudly when none landed.
- **Availability Layer** guarantees *timeliness*: keeping the process alive,
  waking it, reconnecting transport, pulling commands fast. It may fail
  entirely without losing data.

Rule for future changes: never let `USER_PRESENT`, `START_STICKY`,
`AlarmManager`, wake locks or the command stream carry correctness. If a
correctness path needs them, the design is wrong.

Corollary: `GatewayRuntime.reconcile()` is an availability bootstrap only.
Its job is to restart availability-layer components; durable recovery
(`SmsSpoolRecovery`) is invoked from it but is itself part of the core.

## Decision 2 — Push-assisted command delivery (SSE nudge + claim)

The command pipeline keeps **claim/lease + idempotency as the only correctness
mechanism**. A new command stream sits in the Availability Layer purely to cut
latency:

```
Foreground gateway online
        │
        ▼
SSE command stream  ──(nudge: "commands queued")──► immediate claim
        │
WorkManager poll ── fallback / reconcile when the stream is down
```

- Transport: `POST /v1/device-commands/stream`, device-signed with the existing
  HMAC request signature over a JSON body, response `text/event-stream`.
  POST (not GET) so the authenticator's body-signature scheme is reused
  unchanged.
- Event payload is advisory only — `command_queued` carries `deviceId`,
  `queuedAt` and an optional `pending` count. **Command content (recipient,
  body) never rides the stream**; it flows only through `claim`, which is also
  where the server marks `CLAIMED`. One arbitration point, one delivery state
  machine, and no SMS content on a second channel.
- Client on event: `RemoteCommandScheduler.enqueueNow()` → existing claim →
  execute path. End-to-end latency stays well under 1 s online.
- Client when stream is healthy: polling relaxes to a 15-minute reconcile
  (WorkManager is a safety net, not a 15-second scheduler).
- Client when stream is down: polling returns to the 15-second normal cadence,
  and reconnects run with exponential backoff (15 s → 5 min).
- The stream is torn down with the foreground service and rebuilt on
  reconnect; process death loses the stream but never a command — queued
  commands remain in `outbound_commands` and the next claim picks them up.

## Consequences

- Command latency is network RTT + claim when the gateway is online; worst
  case is the poll interval when the stream is down.
- HyperOS killing the main process no longer means "commands stall for many
  minutes with no signal" *while alive-but-disconnected*; when the process is
  actually dead, nothing changes — that is what the passive SMS path and
  WorkManager recovery are for, and the health panel (ADR follows the same
  boundary) must show which layer is degraded.
- Server holds one SSE connection per online gateway plus heartbeats every
  25 s; this is cheap for the current single-node deployment. Multi-node
  deployments would need a shared bus before this scales out.
