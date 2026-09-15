import { isIP } from 'node:net'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const loginAttempts = new Map<string, RateLimitEntry>()
const MAX_ATTEMPTS = 5
const WINDOW_MS = 15 * 60 * 1000
const BLOCK_MS = 30 * 60 * 1000
const MAX_TRACKED_CLIENTS = 10_000

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null
  const candidate = value.trim().replace(/^::ffff:/, '')
  return isIP(candidate) ? candidate : null
}

function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '::1') return true
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
  }
  const normalized = ip.toLowerCase()
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
}

function trustProxyHeaders(remoteAddress: string | null): boolean {
  return process.env.TRUST_PROXY_HEADERS === 'true'
    && remoteAddress !== null
    && isPrivateOrLoopback(remoteAddress)
}

function firstValidHeaderIp(
  value: string | string[] | undefined,
): string | null {
  const combined = Array.isArray(value) ? value.join(',') : value
  if (!combined) return null
  for (const candidate of combined.split(',')) {
    const ip = normalizeIp(candidate)
    if (ip) return ip
  }
  return null
}

function cleanupExpiredEntries(now: number): void {
  for (const [key, entry] of loginAttempts.entries()) {
    if (now >= entry.resetAt) loginAttempts.delete(key)
  }
}

function enforceCapacity(now: number): void {
  cleanupExpiredEntries(now)
  while (loginAttempts.size > MAX_TRACKED_CLIENTS) {
    const oldest = loginAttempts.keys().next().value as string | undefined
    if (!oldest) break
    loginAttempts.delete(oldest)
  }
}

export function checkLoginRateLimit(key: string): {
  allowed: boolean
  retryAfterMs: number
} {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry) return { allowed: true, retryAfterMs: 0 }
  if (now >= entry.resetAt) {
    loginAttempts.delete(key)
    return { allowed: true, retryAfterMs: 0 }
  }
  if (entry.count < MAX_ATTEMPTS) {
    return { allowed: true, retryAfterMs: 0 }
  }
  return { allowed: false, retryAfterMs: entry.resetAt - now }
}

export function recordLoginAttempt(key: string): void {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
  } else {
    entry.count += 1
    if (entry.count >= MAX_ATTEMPTS) {
      entry.resetAt = now + BLOCK_MS
    }
    loginAttempts.delete(key)
    loginAttempts.set(key, entry)
  }
  enforceCapacity(now)
}

export function clearLoginAttempts(key: string): void {
  loginAttempts.delete(key)
}

export function getClientIp(event: {
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>
      socket: { remoteAddress?: string }
    }
  }
}): string {
  const remoteAddress = normalizeIp(event.node.req.socket.remoteAddress)
  if (!trustProxyHeaders(remoteAddress)) {
    return remoteAddress || 'unknown'
  }

  return firstValidHeaderIp(event.node.req.headers['cf-connecting-ip'])
    || firstValidHeaderIp(event.node.req.headers['x-forwarded-for'])
    || firstValidHeaderIp(event.node.req.headers['x-real-ip'])
    || remoteAddress
    || 'unknown'
}

export function resetLoginRateLimiterForTests(): void {
  loginAttempts.clear()
}

export function getTrackedLoginClientCountForTests(): number {
  return loginAttempts.size
}
