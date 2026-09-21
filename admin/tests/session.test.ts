import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAdminConfig } from '../server/utils/config'
import {
  createSession,
  parseSession,
  revokeAdminSession,
  serializeSession,
} from '../server/utils/session'

describe('revocable admin sessions', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'admin-session-'))
    process.env.ADMIN_PASSWORD_HASH = `scrypt:${'aa'.repeat(32)}:${'bb'.repeat(64)}`
    process.env.ADMIN_SESSION_SECRET = '11'.repeat(32)
    process.env.ADMIN_SESSION_STATE_FILE = join(directory, 'session-state.json')
    process.env.ADMIN_PASSWORD_HASH_FILE = '/does/not/exist'
    process.env.ADMIN_SESSION_SECRET_FILE = '/does/not/exist'
    clearAdminConfig()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    delete process.env.ADMIN_SESSION_STATE_FILE
    clearAdminConfig()
  })

  it('survives serialization with persistent revocation state', () => {
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

  it('invalidates a logged-out session while leaving other sessions valid', () => {
    const now = 1_800_000_000_000
    const revoked = createSession(now)
    const active = createSession(now)
    revokeAdminSession(revoked, now + 1_000)

    expect(parseSession(serializeSession(revoked), now + 2_000)).toBeNull()
    expect(parseSession(serializeSession(active), now + 2_000)).toEqual(active)
  })
})
