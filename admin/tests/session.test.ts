import { beforeEach, describe, expect, it } from 'vitest'
import { clearAdminConfig } from '../server/utils/config'
import {
  createSession,
  parseSession,
  serializeSession,
} from '../server/utils/session'

describe('stateless admin sessions', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD_HASH = `scrypt:${'aa'.repeat(32)}:${'bb'.repeat(64)}`
    process.env.ADMIN_SESSION_SECRET = '11'.repeat(32)
    process.env.ADMIN_PASSWORD_HASH_FILE = '/does/not/exist'
    process.env.ADMIN_SESSION_SECRET_FILE = '/does/not/exist'
    clearAdminConfig()
  })

  it('survives serialization without process-local storage', () => {
    const now = 1_800_000_000_000
    const created = createSession(now)
    const parsed = parseSession(serializeSession(created), now + 1_000)
    expect(parsed).toEqual(created)
    expect(parsed?.csrfToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects tampering, expiration, and malformed payloads', () => {
    const now = 1_800_000_000_000
    const serialized = serializeSession(createSession(now))
    const [payload, signature] = serialized.split('.')
    expect(parseSession(`${payload}x.${signature}`, now)).toBeNull()
    expect(parseSession(serialized, now + 24 * 60 * 60 * 1000 + 1)).toBeNull()
    expect(parseSession('not-a-session', now)).toBeNull()
  })

  it('invalidates existing sessions when the secret rotates', () => {
    const now = 1_800_000_000_000
    const serialized = serializeSession(createSession(now))
    process.env.ADMIN_SESSION_SECRET = '22'.repeat(32)
    clearAdminConfig()
    expect(parseSession(serialized, now + 1_000)).toBeNull()
  })
})
