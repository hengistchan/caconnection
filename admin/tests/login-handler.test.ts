import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readBody: vi.fn(),
  setResponseStatus: vi.fn(),
  verifyPassword: vi.fn(),
  verifyTotpCode: vi.fn(),
  consumeRecoveryCode: vi.fn(),
  createTotpChallenge: vi.fn(),
  validateTotpChallenge: vi.fn(),
  consumeTotpChallenge: vi.fn(),
  createSession: vi.fn(),
  requireSameOrigin: vi.fn(),
  setSessionCookie: vi.fn(),
  loadAdminConfig: vi.fn(),
  checkLoginRateLimit: vi.fn(),
  recordLoginAttempt: vi.fn(),
  clearLoginAttempts: vi.fn(),
  getClientIp: vi.fn(),
  setResponseHeaders: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: ({ statusCode, message }: { statusCode: number; message: string }) => (
    Object.assign(new Error(message), { statusCode })
  ),
  readBody: mocks.readBody,
  setResponseStatus: mocks.setResponseStatus,
}))
vi.mock('../server/utils/crypto', () => ({
  verifyPassword: mocks.verifyPassword,
}))
vi.mock('../server/utils/totp', () => ({
  verifyTotpCode: mocks.verifyTotpCode,
}))
vi.mock('../server/utils/totp-state', () => ({
  consumeRecoveryCode: mocks.consumeRecoveryCode,
}))
vi.mock('../server/utils/totp-auth', () => ({
  createTotpChallenge: mocks.createTotpChallenge,
  validateTotpChallenge: mocks.validateTotpChallenge,
  consumeTotpChallenge: mocks.consumeTotpChallenge,
}))
vi.mock('../server/utils/session', () => ({
  createSession: mocks.createSession,
  requireSameOrigin: mocks.requireSameOrigin,
  setSessionCookie: mocks.setSessionCookie,
}))
vi.mock('../server/utils/config', () => ({
  loadAdminConfig: mocks.loadAdminConfig,
}))
vi.mock('../server/utils/rate-limiter', () => ({
  checkLoginRateLimit: mocks.checkLoginRateLimit,
  recordLoginAttempt: mocks.recordLoginAttempt,
  clearLoginAttempts: mocks.clearLoginAttempts,
  getClientIp: mocks.getClientIp,
}))

describe('admin login handler with TOTP', () => {
  let handler: (event: Record<string, unknown>) => Promise<Record<string, unknown>>

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (value: typeof handler) => value)
    vi.stubGlobal('setResponseHeaders', mocks.setResponseHeaders)
    handler = (await import('../server/api/auth/login.post')).default as typeof handler
  })

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.checkLoginRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 })
    mocks.getClientIp.mockReturnValue('198.51.100.4')
    mocks.loadAdminConfig.mockReturnValue({
      passwordHash: 'hash',
      sessionSecret: '11'.repeat(32),
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      totpStatePath: '/tmp/totp-state.json',
    })
    mocks.createSession.mockReturnValue({
      id: 'session',
      csrfToken: 'csrf',
      issuedAt: 1,
      expiresAt: 2,
      version: 1,
    })
  })

  it('does not create a session after only the password step', async () => {
    mocks.readBody.mockResolvedValue({ password: 'correct' })
    mocks.verifyPassword.mockResolvedValue(true)
    mocks.createTotpChallenge.mockReturnValue('challenge')

    await expect(handler({})).resolves.toEqual({
      success: false,
      requiresTotp: true,
      challenge: 'challenge',
    })
    expect(mocks.createTotpChallenge).toHaveBeenCalledWith('198.51.100.4')
    expect(mocks.setSessionCookie).not.toHaveBeenCalled()
  })

  it('creates one session only after a valid challenge and TOTP', async () => {
    mocks.readBody.mockResolvedValue({ challenge: 'challenge', code: '123456' })
    mocks.validateTotpChallenge.mockReturnValue(true)
    mocks.verifyTotpCode.mockReturnValue(true)
    mocks.consumeTotpChallenge.mockReturnValue(true)

    await expect(handler({})).resolves.toEqual({
      success: true,
      csrfToken: 'csrf',
    })
    expect(mocks.consumeTotpChallenge).toHaveBeenCalledWith(
      'challenge',
      '198.51.100.4',
    )
    expect(mocks.setSessionCookie).toHaveBeenCalledTimes(1)
  })

  it('counts invalid or replayed challenges as login failures', async () => {
    mocks.readBody.mockResolvedValue({ challenge: 'replayed', code: '123456' })
    mocks.validateTotpChallenge.mockReturnValue(false)

    await expect(handler({})).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.recordLoginAttempt).toHaveBeenCalledWith('198.51.100.4')
    expect(mocks.setSessionCookie).not.toHaveBeenCalled()
  })
})
