# CA Connection Admin UI

A secure, read-only admin dashboard for the CA Connection Personal Communication Gateway.

## Features

- **Multi-language Support**: Simplified Chinese (default) and English
- **Secure Authentication**: scrypt-hashed passwords with rate-limited login
- **Session Management**: Stateless HMAC-signed HttpOnly cookies with bounded expiry
- **Request Protection**: Per-session CSRF tokens on every authenticated mutation
- **Gateway Status**: Real-time health and readiness monitoring
- **Message Viewer**: Browse SMS messages with SIM filtering
- **OTP Claim**: One-time verification code extraction
- **Privacy Protection**: Sensitive content hidden by default

## Security Architecture

### API Token Protection

The Gateway API token **never** enters the browser:

```
Browser → /admin/api/* → Nuxt Nitro (server) → http://gateway:8787
```

The token is stored as a Docker secret and only accessible server-side.

### Authentication Flow

1. Admin password stored as scrypt hash (random salt)
2. Login attempts rate-limited per IP (5 attempts / 15 minutes)
3. Sessions use HMAC-SHA256 signed, stateless HttpOnly cookies
4. Cookie restricted to `/admin` path with `SameSite=Strict`
5. OTP, pairing, and logout requests require a signed-session CSRF token
6. Proxy IP headers are accepted only when `TRUST_PROXY_HEADERS=true` and the
   direct peer is a loopback/private reverse proxy

### Security Headers

All responses include:
- `Strict-Transport-Security`
- nonce-based `Content-Security-Policy` without `unsafe-inline`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`

## Development

### Prerequisites

- Node.js 24.15+
- npm

### Setup

```bash
cd admin
npm install
```

### Environment Variables (Development)

Create `.env` file:

```env
ADMIN_PASSWORD_HASH=<scrypt hash>
ADMIN_SESSION_SECRET=<random hex string>
ADMIN_API_TOKEN=<gateway api token>
GATEWAY_URL=http://localhost:8787
TRUST_PROXY_HEADERS=false
```

### Run Development Server

```bash
npm run dev
```

Access at http://localhost:3000/admin/

### Run Verification

```bash
npm run verify
```

The audit script always uses the official npm registry because some mirrors do
not implement the audit API.

### Build for Production

```bash
npm run build
```

## Production Deployment

### 1. Generate Credentials

```bash
python3 server/setup_admin.py --runtime-dir server/deploy/runtime
```

This creates:
- `admin-ui-api-token.txt` - Gateway API token (secret)
- `admin-ui-password.txt` - Admin password (secret, show once)
- `admin-ui-password-hash.txt` - Admin password hash
- `admin-ui-session-secret.txt` - Session signing secret
- `admin-config.json` - Setup metadata; it is not mounted into the container
- Updates `config.json` with token hash only

### 2. Set Permissions

```bash
python3 server/prepare_runtime_permissions.py \
  --runtime-dir server/deploy/runtime \
  --deployment-mode cloudflare-tunnel
```

### 3. Deploy

```bash
cd server/deploy
docker compose -f compose.cloudflare.yaml up -d
```

### 4. Credential Rotation

Rotate individual credentials:

```bash
# Rotate API token only
python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-api-token

# Rotate password only
python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-password

# Rotate session secret only
python3 server/setup_admin.py --runtime-dir server/deploy/runtime --rotate-session-secret
```

## Docker Container

### Security Features

- Non-root user (UID 10002)
- Read-only root filesystem
- tmpfs for `/tmp`
- All capabilities dropped
- `no-new-privileges` security option
- Memory/CPU/PID limits
- Health check configured
- No host ports published

### Docker Secrets

The container reads credentials from:
- `/run/secrets/admin_api_token` - Gateway API token
- `/run/secrets/admin_password_hash` - Admin password hash
- `/run/secrets/admin_session_secret` - Session signing secret

## Cloudflare Tunnel Integration

The admin UI is served at `/admin/` via Cloudflare Tunnel ingress:

```yaml
ingress:
  - hostname: caconnection-gatway.hengistchan.online
    path: ^/admin(?:/.*)?$
    service: http://admin:3000
  - hostname: caconnection-gatway.hengistchan.online
    service: http://gateway:8787
  - service: http_status:404
```

This ensures:
- `/admin/*` routes to Nuxt admin UI
- `/v1/events` routes directly to Gateway (Android compatibility)
- `/v1/messages`, `/v1/otp/claim` routes to Gateway
- `/health`, `/ready`, `/version` routes to Gateway

## Pages

### Login (`/admin/login`)

- Password input with show/hide toggle
- Rate-limited login attempts
- Language switcher
- Security notice

### Dashboard (`/admin/`)

- Gateway health status
- Readiness status
- Version information
- SIM1/SIM2 message counts
- Latest message timestamp
- Last refresh time
- One-time QR pairing; creating a new code invalidates the previous code for
  the selected device

### Messages (`/admin/` - Messages tab)

- Filter by SIM (All/SIM1/SIM2)
- Message cards with:
  - Event ID
  - SIM slot indicator
  - Received time
  - Sender (hidden by default)
  - Message body (hidden by default)
  - OTP candidates
  - Claim verification code button

## Internationalization

### Adding a New Language

1. Create locale file: `locales/<code>.json`
2. Add to `nuxt.config.ts`:
   ```ts
   locales: [
     { code: 'zh-CN', name: '简体中文', file: 'zh-CN.json' },
     { code: 'en', name: 'English', file: 'en.json' },
     { code: 'ja', name: '日本語', file: 'ja.json' },  // New
   ]
   ```
3. Copy structure from `en.json` and translate

### Translation Keys

All user-facing strings must use i18n keys. Never hardcode text in components.

## License

Proprietary - CA Connection Project
