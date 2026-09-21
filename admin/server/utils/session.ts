import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { H3Event } from 'h3'
import {
  createError,
  deleteCookie,
  getCookie,
  getRequestHeader,
  setCookie,
} from 'h3'
import { getSessionMaxAge } from './crypto'
import { loadAdminConfig } from './config'
import {
  getSessionGeneration,
  isSessionRevoked,
  revokeSession,
} from './session-state'

const SESSION_COOKIE_NAME = 'ca_admin_session'
const COOKIE_PATH = '/admin'
const SESSION_VERSION = 1

export interface AdminSession {
  version: typeof SESSION_VERSION
  id: string
  issuedAt: number
  expiresAt: number
  csrfToken: string
  generation: number
}

function getSessionSecret(): Buffer {
  return Buffer.from(loadAdminConfig().sessionSecret, 'hex')
}

function encodePayload(payload: AdminSession): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64url')
}

export function serializeSession(session: AdminSession): string {
  const payload = encodePayload(session)
  return `${payload}.${signPayload(payload)}`
}

export function parseSession(
  value: string,
  now = Date.now(),
): AdminSession | null {
  const separator = value.indexOf('.')
  if (separator <= 0 || value.indexOf('.', separator + 1) !== -1) {
    return null
  }

  const encodedPayload = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = signPayload(encodedPayload)
  const suppliedBuffer = Buffer.from(signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (
    suppliedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<AdminSession>
    if (
      parsed.version !== SESSION_VERSION
      || typeof parsed.id !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.id)
      || typeof parsed.csrfToken !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.csrfToken)
      || typeof parsed.issuedAt !== 'number'
      || !Number.isSafeInteger(parsed.issuedAt)
      || typeof parsed.expiresAt !== 'number'
      || !Number.isSafeInteger(parsed.expiresAt)
      || parsed.expiresAt <= parsed.issuedAt
      || parsed.issuedAt > now + 60_000
      || parsed.expiresAt <= now
      || !Number.isSafeInteger(parsed.generation)
      || parsed.generation !== getSessionGeneration(
        loadAdminConfig().sessionStatePath,
      )
      || isSessionRevoked(
        loadAdminConfig().sessionStatePath,
        parsed.id,
        now,
      )
    ) {
      return null
    }
    return parsed as AdminSession
  } catch {
    return null
  }
}

export function createSession(now = Date.now()): AdminSession {
  return {
    version: SESSION_VERSION,
    id: randomBytes(32).toString('hex'),
    issuedAt: now,
    expiresAt: now + getSessionMaxAge() * 1000,
    csrfToken: randomBytes(32).toString('hex'),
    generation: getSessionGeneration(loadAdminConfig().sessionStatePath),
  }
}

export function setSessionCookie(
  event: H3Event,
  session: AdminSession,
): void {
  setCookie(event, SESSION_COOKIE_NAME, serializeSession(session), {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: getSessionMaxAge(),
  })
}

export function getSessionFromCookies(event: H3Event): AdminSession | null {
  const value = getCookie(event, SESSION_COOKIE_NAME)
  return value ? parseSession(value) : null
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE_NAME, {
    path: COOKIE_PATH,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  })
}

export function revokeAdminSession(
  session: AdminSession,
  now = Date.now(),
): void {
  revokeSession(
    loadAdminConfig().sessionStatePath,
    session.id,
    session.expiresAt,
    now,
  )
}

export function requireAuth(event: H3Event): AdminSession {
  const session = getSessionFromCookies(event)
  if (!session) {
    clearSessionCookie(event)
    throw createError({
      statusCode: 401,
      message: 'Authentication required',
    })
  }
  return session
}

function rejectCrossSiteRequest(event: H3Event): void {
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite === 'cross-site') {
    throw createError({ statusCode: 403, message: 'Cross-site request rejected' })
  }

  const origin = getRequestHeader(event, 'origin')
  const host = getRequestHeader(event, 'host')
  if (!origin || !host) return

  try {
    const originUrl = new URL(origin)
    if (
      !['http:', 'https:'].includes(originUrl.protocol)
      || originUrl.host.toLowerCase() !== host.toLowerCase()
    ) {
      throw new Error('origin mismatch')
    }
  } catch {
    throw createError({ statusCode: 403, message: 'Cross-origin request rejected' })
  }
}

export function requireSameOrigin(event: H3Event): void {
  rejectCrossSiteRequest(event)
}

export function requireCsrf(
  event: H3Event,
  session: AdminSession = requireAuth(event),
): void {
  rejectCrossSiteRequest(event)
  const supplied = getRequestHeader(event, 'x-csrf-token')
  if (!supplied) {
    throw createError({ statusCode: 403, message: 'CSRF token required' })
  }

  const expectedBuffer = Buffer.from(session.csrfToken, 'utf8')
  const suppliedBuffer = Buffer.from(supplied, 'utf8')
  if (
    expectedBuffer.length !== suppliedBuffer.length
    || !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    throw createError({ statusCode: 403, message: 'Invalid CSRF token' })
  }
}
