# Production Linux Deployment

This deployment runs the Android gateway receiver behind Caddy:

```text
Android -> public HTTPS -> Caddy -> private HTTP -> Gateway API -> SQLite
```

The backend port is not published on the host. Only TCP 80, TCP 443, and UDP
443 are exposed. Caddy obtains and renews the public certificate. Android uses
normal system-CA validation in production, so routine certificate renewal does
not require reprovisioning the phone. The Node.js and Caddy images are pinned by
digest so a deployment does not silently move to different base-image content.

## Prepare

Requirements:

- a Linux server with Docker Engine and Docker Compose;
- a DNS hostname already pointing to the server;
- inbound TCP 80/443 and UDP 443 allowed.

For a config-file-managed Cloudflare Named Tunnel, inbound 80/443 is not
required. Use the isolated Cloudflare mode below instead of the direct Caddy
mode.

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

### Config-file-managed Cloudflare Tunnel mode

Create a dedicated Named Tunnel with the host's existing Cloudflare account
certificate, then create its DNS route. Do not reuse a remotely managed Tunnel
token or copy a token from another running container.

Prepare the Gateway runtime in Cloudflare mode:

```bash
python3 ../setup_production.py \
  --domain gateway.example.com \
  --deployment-mode cloudflare-tunnel
```

Prepare the config-file-managed tunnel files from the credential JSON created
by `cloudflared tunnel create`:

```bash
python3 ../setup_cloudflare.py \
  --domain gateway.example.com \
  --tunnel-id TUNNEL_UUID \
  --credentials-file /root/.cloudflared/TUNNEL_UUID.json \
  --runtime-dir runtime
```

`compose.cloudflare.yaml` runs a dedicated pinned cloudflared connector. It
mounts the tunnel config and credential as Docker secrets, connects directly
to the private Gateway network, and publishes no host port. Existing
cloudflared system services and containers remain independent.

On native Linux, Compose implements local secrets as read-only bind mounts.
`deploy.sh` therefore assigns `config.json` only to Gateway UID 10001 and the
two Tunnel files only to cloudflared UID 65532, all mode `0400`, before
starting containers. This step requires root unless those exact owners are
already present.

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

In Cloudflare Tunnel mode, Cloudflare provides public TLS and the dedicated
connector forwards directly to the private Gateway container. The Gateway
itself emits HSTS and the other API security headers. The connector and
Gateway have no host port bindings.

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

## Admin UI

An authenticated admin dashboard for message monitoring, remote SMS commands,
OTP claims, and short-lived Android pairing is available at:

```text
https://gateway.example.com/admin/
```

### Setup Admin Credentials

Generate admin UI credentials:

```bash
python3 ../setup_admin.py --runtime-dir runtime
```

This creates:
- `admin-ui-api-token.txt` - Gateway API token (`messages:read`,
  `messages:send`, `otp:claim`, `pairing:create`, and
  `notifications:manage`, `devices:read`, and `devices:write` scopes)
- `admin-ui-password.txt` - Admin password (show once, then securely store)
- `admin-config.json` - Admin configuration (password hash, session secret)
- `admin-ui-totp-secret.txt` - Empty unless TOTP is explicitly enabled
- `admin-totp-state/totp-state.json` - Writable hashed recovery-code state
- `admin-totp-state/session-state.json` - Writable session generation and
  logout-revocation state

The Gateway `config.json` is updated with only the token SHA-256 hash.

### Configure Notification Connections

Create a private file containing only the custom-bot Webhook URL, then run:

```bash
python3 ../setup_feishu.py \
  --runtime-dir runtime \
  --webhook-url-file /secure/path/feishu-webhook.txt
```

If the Feishu bot has signature verification enabled, also pass:

```bash
--signing-secret-file /secure/path/feishu-signing-secret.txt
```

The values are stored only inside the protected Gateway `config.json`; the
setup command and Admin API never print or return them. The same protected
`notifications.channels` section can define Bark and Generic Webhook
connections. After deployment, use the Admin **Notification Connections** tab
to choose redacted/full-content mode, select events, enable delivery, and queue
a test notification.

### Set Permissions

```bash
python3 ../prepare_runtime_permissions.py \
  --runtime-dir runtime \
  --deployment-mode cloudflare-tunnel \
  --enable-admin
```

### Deploy with Admin UI

```bash
docker compose -f compose.cloudflare.yaml up -d
```

### Credential Rotation

Rotate individual credentials:

```bash
# Rotate API token
python3 ../setup_admin.py --runtime-dir runtime --rotate-api-token

# Rotate admin password
python3 ../setup_admin.py --runtime-dir runtime --rotate-password

# Rotate session secret
python3 ../setup_admin.py --runtime-dir runtime --rotate-session-secret

# Enable TOTP
python3 ../setup_admin.py --runtime-dir runtime --enable-totp

# Replace the TOTP secret and all recovery codes
python3 ../setup_admin.py --runtime-dir runtime --rotate-totp

# Disable TOTP and invalidate all recovery codes
python3 ../setup_admin.py --runtime-dir runtime --disable-totp
```

When TOTP is enabled, securely import `runtime/admin-ui-totp-uri.txt` into an
authenticator and store `runtime/admin-ui-totp-recovery-codes.txt` separately.
Only the TOTP secret and hashed recovery state are mounted into the Admin
container. Include the TOTP secret, current hashed recovery state, setup URI,
and plaintext recovery codes in protected off-host backups. A restored recovery
state must not re-enable codes that were consumed after the backup.

Rotating the Admin password or session secret increments the persistent session
generation and invalidates all previously issued Admin cookies. Logout
revocations survive Admin process and container restarts.

TOTP challenges and login rate limits are process-local, so the current
deployment supports exactly one Admin replica.

After a credential change, run the permission preparation step and restart the
admin container:

```bash
python3 ../prepare_runtime_permissions.py \
  --runtime-dir runtime \
  --deployment-mode cloudflare-tunnel \
  --enable-admin
docker compose -f compose.cloudflare.yaml restart admin
```

### Security Features

- API token never reaches the browser (server-side proxy only)
- scrypt-hashed passwords with random salt
- Optional TOTP with single-use client-bound challenges
- Persistent recovery codes stored only as hashes and atomically consumed
- Rate-limited login (5 attempts / 15 minutes per IP)
- HMAC-signed HttpOnly session cookies
- Persistent logout revocation and credential-rotation invalidation
- All sensitive responses marked `Cache-Control: no-store`
- Content hidden by default (sender, message body)
- OTP codes auto-clear after 30 seconds
- Android pairing QR codes expire after five minutes and contain only a
  one-time token. The long-lived device secret is returned only over the
  verified HTTPS claim connection and the token cannot be reused.

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
