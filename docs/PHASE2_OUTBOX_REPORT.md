# Phase 2 Local Outbox Verification Report

- Date: **2026-09-12**
- Device: **Xiaomi 17 Pro Max / Android 17 / API 37**
- Installed build: **0.1.0-poc-target37-debug**
- Scope: **local queue and Mock Transport only**

## Implemented flow

```text
IncomingSmsProcessor
  -> Room transaction
       IncomingSmsEvent
       OutboxEvent
  -> OutboxScheduler
  -> WorkManager OutboxWorker
  -> OutboxProcessor
  -> MockTransport
  -> persisted SUCCESS / RETRY / FAILED
```

The manifest still declares no `INTERNET` permission. The current Transport
cannot contact a server.

## Reliability properties

- Incoming and Outbox rows are created in one Room transaction.
- A full SHA-256 idempotency key is generated from sender, timestamp, body,
  multipart count, subscription ID, and slot.
- The unique database index ignores a duplicate Outbox insert.
- Work is scheduled after each committed Outbox insert.
- Application startup schedules a recovery drain for durable pending rows.
- Workers claim due rows conditionally before delivery, preventing concurrent
  workers from delivering the same row.
- Retryable failures use persisted exponential backoff capped at five minutes.
- The tenth failed attempt becomes terminal `FAILED`.
- An `IN_PROGRESS` row older than ten minutes is recovered to `RETRY`.
- The user-visible clear operation also clears Outbox payload copies.

## Verification performed

Both target variants completed **27/27 unit tests**, lint with zero errors, and
APK assembly under the project's pinned Gradle 9.6.0 wrapper. Lint also reports
four dependency-version availability warnings, which do not fail the build.
Tests cover:

- SHA-256 key format and deterministic duplicate detection;
- separation of identical content received on different SIMs;
- payload field creation;
- local self-test event creation;
- successful state transition through `IN_PROGRESS` to `SUCCESS`;
- retry state and explicit retry delay;
- terminal failure on the tenth attempt;
- missing-payload failure without calling Transport;
- coroutine cancellation propagation without falsely recording a retry;
- the production exponential-backoff calculation and cap.

The targetSdk 37 APK was installed over the existing database. Room opened the
existing schema at version 2 without losing the six previously captured
inbound records.

The Diagnostics **Run local Outbox self-test (no network)** action was first
executed at **2026-09-12 14:41:05 +08:00**. After rebuilding with the verified
Gradle 9.6.0 wrapper and reinstalling the final targetSdk 37 APK, it was
executed again at **14:50:47 +08:00**. Device logs showed Mock Transport
accepting and completing both generated idempotency keys. Direct Room
inspection, without reading any SMS payload, showed:

```text
payloadType=LOCAL_SELF_TEST
status=SUCCESS
retryCount=0
lastError=NULL
count=2
```

The WorkManager database showed completed `OutboxWorker` work tagged
`outbox_processing`. The Room database remained at schema version 2 and
retained all six previously captured inbound records.

## Boundaries

- `SUCCESS` currently means acknowledgment by Mock Transport, not cloud
  delivery.
- No real endpoint, authentication, TLS policy, E2EE, or server acknowledgment
  contract exists yet.
- Real inbound SMS to Outbox creation should be observed on the next naturally
  arriving message; no paid or synthetic telephony message was used for this
  verification.
- The Gateway still relies on the separately documented managed-process
  assumption and HyperOS `MIUIOP(10018)` provisioning.
