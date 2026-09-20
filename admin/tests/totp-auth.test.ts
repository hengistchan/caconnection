import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeTotpChallenge,
  createTotpChallenge,
  resetTotpChallengesForTests,
  validateTotpChallenge,
} from '../server/utils/totp-auth'

describe('TOTP login challenges', () => {
  beforeEach(() => resetTotpChallengesForTests())

  it('binds a short-lived challenge to the password-authenticated client', () => {
    const now = 1_800_000_000_000
    const challenge = createTotpChallenge('client-a', now)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(validateTotpChallenge(challenge, 'client-a', now + 1_000)).toBe(true)
    expect(validateTotpChallenge(challenge, 'client-b', now + 1_000)).toBe(false)
    expect(validateTotpChallenge(challenge, 'client-a', now + 5 * 60 * 1000 + 1)).toBe(false)
  })

  it('allows a valid challenge to be consumed only once', () => {
    const now = 1_800_000_000_000
    const challenge = createTotpChallenge('client-a', now)
    expect(consumeTotpChallenge(challenge, 'client-a', now + 1_000)).toBe(true)
    expect(consumeTotpChallenge(challenge, 'client-a', now + 1_001)).toBe(false)
  })
})
