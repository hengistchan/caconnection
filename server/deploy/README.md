# Production Linux Deployment

This deployment runs the Android gateway receiver behind Caddy:

```text
Android -> public HTTPS -> Caddy -> private HTTP -> Gateway API -> SQLite
```

The backend port is not published on the host. Only TCP 80, TCP 443, and UDP
443 are exposed. Caddy obtains and renews the public certificate. Android uses
normal system-CA validation in production, so routine certificate renewal does
not require reprovisioning the phone. The Python and Caddy images are pinned by
digest so a deployment does not silently move to different base-image content.

## Prepare

Requirements:

- a Linux server with Docker Engine and Docker Compose;
- a DNS hostname already pointing to the server;
- inbound TCP 80/443 and UDP 443 allowed.

Before creating credentials or changing the host, run the read-only preflight:

```bash
python3 ../production_preflight.py --domain gateway.example.com
```

It checks Linux, available disk, Docker/Compose access, clock
synchronization, port conflicts, public DNS, outbound ACME reachability, and
whether host firewall state still needs manual review. It never changes
packages, services, firewall rules, or runtime configuration. Inbound
reachability cannot be proven from the server itself and must still be checked
externally.

Generate private runtime files:

```bash
python3 ../setup_production.py --domain gateway.example.com
```

Then validate the generated files without printing their contents:

```bash
python3 ../production_preflight.py \
  --domain gateway.example.com \
  --require-runtime
```

Rotate an API bearer token or device secret only as an explicit maintenance
operation:

```bash
python3 ../setup_production.py \
  --domain gateway.example.com \
  --rotate-api-token

python3 ../setup_production.py \
  --domain gateway.example.com \
  --rotate-device-secret
```

Device-secret rotation requires reprovisioning Android before uploads can
resume. Existing Outbox rows remain queued during that interval.

The command writes, but never prints:

- the device shared secret;
- the hashed API-client configuration;
- the API bearer token;
- an Android provisioning file.

Runtime files under `runtime/` and `.env` are ignored by Git.

## Start

```bash
./deploy.sh
```

Verify:

```bash
./check.sh
```

The check performs all of the following:

- public system-CA TLS validation through the production hostname;
- `/health`, `/ready`, and `/version`;
- one HMAC-authenticated, AES-256-GCM encrypted event through Caddy to the
  private receiver;
- authenticated access to the message API without printing response content.

Caddy access logging is intentionally disabled so bearer tokens and gateway
authentication headers cannot be copied into reverse-proxy access logs. The
gateway application logs only the client address, request line, and response
status; it never logs headers or request/response bodies.

## Read messages

Use the bearer token stored in:

```text
runtime/automation-api-token.txt
```

```bash
curl --fail \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  "https://gateway.example.com/v1/messages?limit=20"
```

## Claim the latest OTP once

```bash
curl --fail \
  -X POST \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slotIndex":0,"maxAgeSeconds":600}' \
  https://gateway.example.com/v1/otp/claim
```

An event can be claimed only once. OTP plaintext is derived from the encrypted
SMS in memory and is not stored in a separate plaintext database column.

## Backup

```bash
./backup.sh
```

The backup uses SQLite's online backup API, runs an integrity check, and keeps
the newest 14 backups by default. It first writes to a dedicated Docker backup
volume, then exports a checksum-verified copy to:

```text
runtime/backups/
```

Copy this directory to encrypted off-host storage. A backup kept only on the
same server is not a disaster-recovery copy.

Restore a selected backup:

```bash
./restore.sh runtime/backups/gateway-TIMESTAMP.db
```

The restore command stops only the gateway backend, verifies the backup in an
ephemeral non-root container, atomically replaces the database, restarts the
backend even if restoration fails, and waits for `/ready` before reporting
success.

## Android cutover

Do not change the phone until the public `/ready` endpoint and signed protocol
test pass. Install the final release APK, then import the private configuration:

```bash
./provision_android.sh
```

The provisioning receiver is protected by Android's privileged `DUMP`
permission. The file is read from the app-specific external directory, stored
with Android Keystore protection, deleted immediately, and followed by an
Outbox drain.

Recheck HyperOS `MIUIOP(10018)`, queue a self-test, and send one natural SMS or
OTP to each SIM.

Immediately before sending the natural tests, capture a private server-side
baseline:

```bash
./cutover_acceptance.sh \
  --url https://gateway.example.com \
  --token-file runtime/automation-api-token.txt \
  baseline \
  --output runtime/cutover-baseline.json
```

After sending an OTP-bearing message to SIM1, verify that it reached the
correct slot and that the exact message can be claimed only once:

```bash
./cutover_acceptance.sh \
  --url https://gateway.example.com \
  --token-file runtime/automation-api-token.txt \
  verify \
  --baseline runtime/cutover-baseline.json \
  --slot 0
```

Repeat for SIM2 with `--slot 1`. The tool uses the baseline message IDs and
the API's exact `eventId` claim selector. It deliberately does not print the
sender, message body, OTP value, API token, or Android shared secret.

The production APK package is:

```text
com.caconnection.gateway
```

It is intentionally distinct from `com.caconnection.debug` and the older
`com.caconnection` test package. Do not uninstall either older package until
the production phone-to-server path has passed and the user approves cleanup.

## Routine operations

- Run `./check.sh` after every deployment or credential rotation.
- Run `./backup.sh` on a schedule and copy `runtime/backups/` off-host.
- Keep `runtime/config.json`, `runtime/android-provisioning.json`, the API
  token file, and Android signing material out of source control and support
  logs.
- Device-secret rotation requires Android reprovisioning. API-token rotation
  requires updating API consumers.
- `deploy.sh` force-recreates the containers so changed runtime secrets are
  loaded rather than left only on disk.
