import { createHash, randomBytes } from 'node:crypto'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_CHALLENGES = 10_000

interface TotpChallenge {
  clientKey: string
  expiresAt: number
}

const challenges = new Map<string, TotpChallenge>()

function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function cleanup(now: number): void {
  for (const [hash, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now) challenges.delete(hash)
  }
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined
    if (!oldest) break
    challenges.delete(oldest)
  }
}

export function createTotpChallenge(
  clientKey: string,
  now = Date.now(),
): string {
  cleanup(now)
  const token = randomBytes(32).toString('base64url')
  challenges.set(tokenHash(token), {
    clientKey,
    expiresAt: now + CHALLENGE_TTL_MS,
  })
  return token
}

export function validateTotpChallenge(
  value: string,
  clientKey: string,
  now = Date.now(),
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  cleanup(now)
  const challenge = challenges.get(tokenHash(value))
  return challenge !== undefined
    && challenge.clientKey === clientKey
    && challenge.expiresAt > now
}

export function consumeTotpChallenge(
  value: string,
  clientKey: string,
  now = Date.now(),
): boolean {
  if (!validateTotpChallenge(value, clientKey, now)) return false
  return challenges.delete(tokenHash(value))
}

export function resetTotpChallengesForTests(): void {
  challenges.clear()
}
