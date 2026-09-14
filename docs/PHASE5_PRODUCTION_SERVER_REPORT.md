# Phase 5 — Production Server and Android Cutover Readiness

Date: 2026-09-14

## Result

The Phase 5 server implementation passes its local code, container,
cryptographic, and operational acceptance gates. The phone-to-local-receiver
encrypted baseline also passes. The latest Android reliability and visual
header build passes automated tests, but its final on-device visual check is
pending because wireless ADB disconnected after the user reported that the
header still looked visually merged with the status bar.

The production runtime is now implemented as:

```text
Xiaomi Android gateway
  -> durable Room Outbox
  -> schema-v2 AES-256-GCM payload
  -> timestamp + nonce + HMAC-SHA256 authenticated HTTPS
  -> Caddy public TLS endpoint
  -> private non-root Gateway API container
  -> encrypted SQLite envelope storage
  -> bearer-authenticated message API / atomic one-time OTP claim API
```

The Mac remains only the temporary Phase 4 development receiver. It is not a
component of the production architecture.

Formal deployment to a public server has not yet been performed because the
repository does not contain, and must not invent, the required SSH target,
production hostname, DNS state, or production Android signing key. The phone
therefore remains on the verified local receiver until the public deployment
passes.

## Production API

The receiver exposes:

```text
GET  /health
GET  /ready
GET  /version
POST /v1/events
GET  /v1/messages
POST /v1/otp/claim
```

`/v1/events` preserves the Phase 4 protocol:

- AES-256-GCM encrypted payload;
- HKDF-SHA256 per-device encryption key derivation;
- HMAC-SHA256 over timestamp, nonce, device ID, idempotency key, and exact
  encrypted request body;
- five-minute request-clock window;
- request-nonce replay rejection;
- server-side idempotency.

`/v1/messages` requires a bearer token with `messages:read`. It decrypts
incoming SMS payloads in memory and returns the sender, body, SIM attribution,
and ranked OTP candidates.

`/v1/otp/claim` requires `otp:claim`. It:

- scans eligible encrypted incoming messages within the requested age window;
- extracts likely 4-to-8-digit English or Chinese OTP candidates in memory;
- prioritizes candidates near OTP-specific context;
- atomically records the event as claimed;
- returns the selected code only once;
- does not add a plaintext OTP column to SQLite.

API bearer tokens are never stored directly in server configuration. The
configuration contains only SHA-256 token hashes and scopes.

## Server hardening

The deployment uses Docker Compose and Caddy:

- only TCP 80, TCP 443, and UDP 443 are published;
- the Python backend port is exposed only on an internal Docker network;
- Caddy obtains and renews the public certificate;
- Android production configuration uses normal system-CA validation;
- the gateway runs as UID 10001, not root;
- the gateway root filesystem is read-only;
- the Python and Caddy base images are pinned by immutable digest;
- Linux capabilities are dropped;
- `no-new-privileges` is enabled;
- PID, CPU, memory, log-size, and request-concurrency limits are configured;
- containers restart automatically unless explicitly stopped;
- Caddy access logging is not enabled, preventing bearer and gateway
  authentication headers from entering reverse-proxy access logs;
- application logs omit headers and request/response bodies.

Rate limiting is applied independently to:

- unauthenticated ingestion by client IP;
- authenticated ingestion by device ID;
- API authentication attempts by client IP;
- authenticated API requests by API client ID.

Rate-limiter identity storage is periodically pruned and bounded.

## Storage, retention, backup, and restore

The receiver stores only the encrypted schema-v2 envelope. Routing metadata
such as event type, timestamps, device ID, and SIM attribution remains visible.

Retention defaults to 30 days and is configurable. Pruning runs after accepted
ingestion and removes the associated OTP-claim record before deleting an
expired event.

SQLite uses a persistent data volume. Backups use SQLite's online backup API,
run `PRAGMA integrity_check`, and are retained in a separate backup volume.
The deployment backup command then:

1. copies the backup to the private host `runtime/backups/` directory;
2. compares container and host SHA-256 checksums;
3. applies host-side retention.

The host backup directory must still be copied to encrypted off-host storage
for real disaster recovery.

Restore:

- requires an explicit backup path;
- stops only the gateway backend;
- verifies and copies the backup in an ephemeral non-root container;
- atomically replaces the database;
- restarts the backend even if restoration fails;
- waits for `/ready` before reporting success.

## Production credential preparation

`server/setup_production.py` creates ignored, private files without printing
credential values:

```text
server/deploy/.env
server/deploy/runtime/config.json
server/deploy/runtime/android-provisioning.json
server/deploy/runtime/automation-api-token.txt
```

The setup tool:

- validates the production DNS hostname;
- creates a random 256-bit device secret;
- creates a random API bearer token;
- stores only the API token hash in server configuration;
- preserves existing credentials unless an explicit rotation flag is used;
- writes files with owner-only permissions;
- includes `enabled: true` in Android provisioning;
- provides separate API-token and device-secret rotation operations.

`deploy.sh` force-recreates the containers so changed secret-file contents are
loaded into process memory after rotation.

## Android production changes

The production release application ID is:

```text
com.caconnection.gateway
```

It is intentionally separate from:

```text
com.caconnection.debug
com.caconnection
```

This allows a controlled side-by-side cutover without overwriting or
uninstalling the earlier packages.

Production signing configuration is read only from:

```text
CACONNECTION_RELEASE_KEYSTORE
CACONNECTION_RELEASE_STORE_PASSWORD
CACONNECTION_RELEASE_KEY_ALIAS
CACONNECTION_RELEASE_KEY_PASSWORD
```

No production key or password is present in the repository.

The Android transport shared secret is no longer stored in plaintext
preferences. It is encrypted with an app-private Android Keystore AES-GCM key.
Existing plaintext preferences are migrated once and removed.

The production provisioning receiver:

- is protected by privileged `android.permission.DUMP`;
- reads one fixed file from the app-specific external directory;
- validates schema, HTTPS origin, device ID, 256-bit-or-stronger secret, and
  optional certificate pin;
- defaults an omitted `enabled` field to `true`;
- stores the secret through Android Keystore;
- deletes the provisioning file after either success or rejection;
- schedules an Outbox drain after success.

Temporary transport failures no longer become terminal after ten attempts.
Network exceptions, HTTP 408/425/429, and server 5xx responses remain in the
durable `RETRY` state indefinitely, use exponential backoff capped at five
minutes, and resume after process/device recovery. Authentication, malformed
data, and other permanent protocol failures still become `FAILED`.

On first worker execution after upgrading, rows that an older build marked
`FAILED` only because it exhausted the historical ten-attempt limit are
selectively returned to `RETRY`. Other permanent failures are not requeued.

The HTTPS configuration supports:

- a pinned self-signed certificate for the existing local receiver;
- normal system-CA validation with no pin for the production hostname.

## Android UI correction

Target SDK 37 edge-to-edge behavior placed the status bar over the app's
heading. The application now:

- uses a real `NoActionBar` theme rather than hiding a dark action bar after
  activity creation;
- applies status-bar, navigation-bar, and display-cutout insets to the root
  layout;
- preserves the original content padding.

On the physical 1200-by-2608 display, the verified bounds changed from:

```text
title top: 36 px, overlapped by the 144 px status/cutout inset
```

to:

```text
title:         [36,180] to [1164,372]
navigation:    [36,372] to [1164,516]
content start: y=516
```

The visible pink navigation controls were reported clickable and no longer
intersect the heading or system status area. The user subsequently reported
that the header still looked visually blended with the status bar even though
the bounds no longer overlapped. A second visual correction now adds:

- an additional 8 dp top gap;
- a rounded dark-purple application-header surface;
- a contrasting border and elevation;
- internal 16 dp header padding;
- a slightly smaller 22 sp title.

This second correction has passed resource compilation, targetSdk 37 unit
tests, APK assembly, and lint. It still requires installation and visual
confirmation when the phone reconnects.

## Automated verification

Python:

```text
25/25 tests passed
compileall passed
OpenAPI 3.1 YAML parse passed
shell syntax checks passed
git diff whitespace check passed
```

Coverage includes:

- protocol-v2 encryption/HMAC golden vector shared with Android;
- tamper rejection and generic cryptographic errors;
- replay, timestamp, idempotency, input validation, and retention behavior;
- message authentication and scope enforcement;
- IP, device, and API-client rate limiting;
- English/Chinese OTP ranking;
- atomic one-time OTP claims;
- production setup, credential preservation, and explicit rotation;
- backup consistency, retention, integrity, and restore;
- a signed encrypted deployment smoke request using a separate TCP connection
  host while preserving TLS SNI and hostname validation.

Android:

```text
targetSdk 36: 57/57 unit tests passed
targetSdk 37: 57/57 unit tests passed
targetSdk 36 Debug APK assembled
targetSdk 37 Debug APK assembled
targetSdk 37 unsigned Release APK assembled
targetSdk 36 lint passed
targetSdk 37 lint passed
```

An ephemeral signing-key acceptance test also passed:

```text
APK Signature Scheme v2: true
package:                 com.caconnection.gateway
label:                   CA Gateway
debuggable:              false
provisioning receiver:   android.permission.DUMP protected
```

The ephemeral key and test-signed APK were deleted immediately afterward.

## Production-container acceptance

A clean temporary Compose project verified:

```text
gateway image build:                 passed
non-root/read-only backend health:   passed
private backend network:             passed
Caddy TLS reverse proxy:             passed
signed encrypted proxy smoke:        HTTP 201
authenticated message API:           passed
event persisted:                     1
checksum-verified host backup:        passed
second event before restore:          2
atomic restore result:                1
post-restore /ready:                  passed
post-restore Caddy /health:           passed
known plaintext scan of DB/backup:    0 matches
temporary containers/volumes/files:  removed
```

The final image contains neither deployment runtime files nor local receiver
credentials and runs as the non-root `gateway` user.

## Physical Android acceptance

The targetSdk 37 insets build was installed over the existing physical gateway
package with app data retained. The subsequently built header-surface and
indefinite-retry update is not yet installed because the phone is currently
disconnected from ADB.

Baseline post-install verification:

```text
legacy plaintext shared-secret preference: absent
encrypted secret ciphertext preference:    present
encrypted secret nonce preference:         present
deterministic Android encrypted self-test:  received by local HTTPS server
gateway readiness:                          READY
default SMS application:                    com.android.mms
default dialer:                             com.android.contacts
call-screening role:                        com.caconnection.debug
MIUIOP(10018):                              allow
```

HyperOS again changed `MIUIOP(10018)` during package replacement. Only this
previously approved AppOp was restored, then rechecked. No default
application, battery setting, or background policy was changed.

No paid outbound SMS was sent for this acceptance run.

## Security boundary

The production server is trusted. It has the per-device shared secret and can
decrypt SMS bodies in memory. A bearer client with the required scope can read
messages or claim an OTP.

Therefore this implementation protects:

- network transport;
- request authenticity;
- replay and duplicate handling;
- ciphertext-at-rest storage;
- accidental credential logging;
- unauthorized API use under the configured token model.

It does not protect message plaintext from:

- a compromised production server;
- a process with access to the runtime configuration;
- an authorized API client;
- the Android gateway application itself.

A cloud-blind relay would require a different recipient public-key design and
is not claimed by Phase 5.

## Remaining formal deployment gate

Code acceptance is complete. Public deployment requires the operator to
provide or confirm:

```text
SSH host or alias
SSH user
SSH port
production Linux distribution/version
production DNS hostname
DNS already pointing to the server
TCP 80/443 and UDP 443 firewall/admin access
secure destination for the production Android signing key and passwords
```

After those inputs are available, the required cutover sequence is:

1. inspect the server without modifying it;
2. verify Docker/Compose, ports, DNS, firewall, disk, time sync, and existing
   services;
3. generate production runtime credentials;
4. generate and securely retain the real Android production signing key;
5. deploy and run public TLS, readiness, version, signed protocol, and
   authenticated message-API checks;
6. create and export a verified backup;
7. build and verify the signed production APK;
8. install `com.caconnection.gateway` side by side;
9. grant and recheck the approved Android permissions and roles;
10. import production provisioning without printing secrets;
11. verify an Android self-test through the public server;
12. verify one natural SIM1 and one natural SIM2 SMS/OTP end to end;
13. verify authenticated message retrieval and one-time OTP claim behavior;
14. only then disable the Debug gateway and retire the Mac receiver.

Until that sequence succeeds, the verified local Phase 4 transport remains
active and the production cutover is not claimed complete.
