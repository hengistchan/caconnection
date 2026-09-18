# Multi-Gateway Architecture

Status: implemented locally as of 2026-09-18.

This document defines how CA Connection identifies, isolates, operates, and
tests multiple Android Gateway devices. It is the contract for the Android
app, Gateway API, Admin UI, and API clients.

## 1. Stable routing identity

The stable route for a cellular line is:

```text
(deviceId, slotIndex)
```

- `deviceId` identifies one managed Android Gateway.
- `slotIndex` identifies a physical SIM slot on that Gateway. The current
  outbound command API accepts slot `0` or `1`.
- `subscriptionId` is reported as telemetry. Android and an OEM may reassign it
  after a reboot, SIM change, eSIM change, or carrier reconfiguration, so it
  must not be used as the durable cross-device routing key.

Inbound messages, notifications, device state, outbound commands, command
history, pairing sessions, and OTP claims all retain `deviceId`.

## 2. Explicit outbound selection

Every remote-send request must contain both:

```json
{
  "deviceId": "gateway-a",
  "slotIndex": 0
}
```

The server queues the command only for that device. The Android Gateway claims
only commands addressed to itself and sends through the requested active slot.

There is deliberately:

- no automatic Gateway selection;
- no automatic SIM selection;
- no load balancing between Gateways;
- no retry through another Gateway;
- no failover from one SIM slot to another.

If the selected Gateway or line is unavailable, the command remains associated
with that route and eventually fails or expires. An operator must explicitly
choose another route and create a new command.

Gateway groups never select an outbound route. They are organizational and
read-filtering constructs only.

## 3. API-client isolation

Each bearer-token client has:

- one or more scopes, such as `messages:read`, `messages:send`, `otp:claim`,
  and `pairing:create`;
- an optional `allowedDeviceIds` list.

If `allowedDeviceIds` is present, reads and mutations are limited to those
devices. A client cannot use a device ID, group, pairing operation, lifecycle
operation, outbound command, or OTP claim to cross that boundary. A client
without `allowedDeviceIds` has global device access, subject to its scopes.

Restricted clients may read only the accessible members of a Gateway group.
They cannot create, update, or delete groups because group membership is a
global administrative concern.

## 4. Device lifecycle

### Active

An active device can authenticate, report state, upload events, claim its
outbound commands, be paired, and be selected by authorized API clients.

The server derives health from last activity:

- `ONLINE`: seen within 3 minutes;
- `STALE`: seen more than 3 minutes but no more than 15 minutes ago;
- `OFFLINE`: last seen more than 15 minutes ago;
- `NEVER`: no activity has been observed.

Health is operational telemetry and does not trigger rerouting.

### Retired

Retirement is the normal reversible removal operation.

- Device authentication is rejected.
- New pairing and command activity is rejected.
- Queued or claimed commands for the device are expired.
- Historical events and the device secret are retained, so previously
  encrypted content remains decryptable.
- The device can be restored explicitly.

### Purged

Purge is an explicit irreversible operation requiring the exact confirmation
text `PURGE {deviceId}`.

It removes the device, secret, events, status, line telemetry, pairing data,
outbound history, OTP claims associated with its events, and group membership.
Deleting a Gateway group does not purge its member devices.

### Secret rotation

Changing a device secret re-encrypts existing encrypted event and outbound
payloads in the same database transaction before the new secret becomes
active. Historical content therefore remains readable after a successful
rotation.

## 5. OTP isolation

OTP claims are one-time and client-scoped.

- A latest-OTP claim without an exact `eventId` must specify `deviceId`.
- `slotIndex` may further constrain the stable route.
- An exact `eventId` claim is deterministic when multiple OTP messages exist.
- `allowedDeviceIds` is enforced before a code can be claimed.
- A successfully claimed event cannot be claimed again by another client.

The API never searches all Gateways for a latest OTP when the caller omits the
device. This prevents an unrelated Gateway from satisfying the request.

## 6. Gateway groups

Groups support:

- Admin organization;
- URL-persistent Admin context;
- group-filtered message, notification, and outbound-history reads.

`deviceId` and `groupId` filters are mutually exclusive. Filtering is applied
in SQL before `LIMIT`, so a page is not accidentally filled with inaccessible
or out-of-group records and then filtered afterward.

Groups do not own devices. Deleting a group removes only the grouping. Purging
a device removes its memberships.

## 7. Ordinary-SMS evidence is separate from OTP evidence

OTP success does not prove that ordinary person-to-person SMS delivery works.
OEM firmware may classify or dispatch service and verification messages
differently.

Each device reports three independent forms of evidence:

1. `lastOtpAt`: a successfully processed incoming message contained an OTP
   candidate.
2. `lastOrdinarySmsAt`: a successfully processed incoming message did not
   contain an OTP candidate.
3. Receiver diagnostics:
   - `lastReceiverInvokedAt` and `lastReceiverInvokedAction`;
   - `lastReceiverParseFailureAt` and
     `lastReceiverParseFailureReason`.

Receiver failure reasons are intentionally metadata-only:

- `NO_MESSAGES`;
- `PARSER_EXCEPTION`;
- `PROCESSING_EXCEPTION`.

They never contain a sender, recipient, SMS body, PDU, OTP value, or secret.
Admin warns when OTP was observed but no ordinary SMS has been verified, and
when the latest receiver parse failure is newer than the latest successfully
processed incoming SMS.

## 8. Real-device acceptance

Local tests prove routing, isolation, lifecycle, persistence, API validation,
and UI behavior. They cannot prove carrier delivery to a physical device.

For each production Gateway and each active SIM slot:

1. Confirm the expected `deviceId`, `slotIndex`, current `subscriptionId`, and
   carrier in Admin.
2. Confirm `RECEIVE_SMS` is granted and the reported receive mode is expected.
3. Send a real ordinary non-OTP SMS from an external phone.
4. Record the sender-side sent time without recording the message body in test
   logs.
5. Confirm a new incoming record appears under the exact
   `(deviceId, slotIndex)` route.
6. Confirm `lastOrdinarySmsAt` advances.
7. If no message appears:
   - if Receiver invocation advances, inspect the parse-failure reason;
   - if invocation does not advance, investigate Android/OEM broadcast
     delivery, permissions, process restrictions, and default-SMS behavior.
8. Repeat for every active SIM. Do not infer one line or Gateway from another.

Run a real OTP test separately. Passing either test does not substitute for the
other.

Outbound acceptance is also per route and requires separate authorization
because it can incur carrier charges. Confirm queued, sent, and delivery/failure
status without testing automatic fallback, because no such fallback exists.

## 9. Verification boundary

The implementation can demonstrate:

- deterministic `(deviceId, slotIndex)` routing;
- API-client device isolation;
- group-scoped reads;
- reversible retirement and irreversible purge;
- per-device OTP claims;
- distinction between OTP, ordinary SMS, and receiver parse failures.

Production acceptance remains incomplete for any physical Gateway/SIM route
that has not received a real ordinary SMS during the current acceptance run.

