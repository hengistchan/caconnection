import { pbkdf2 } from 'node:crypto'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  generateSessionToken,
  hashPassword,
  safeCompare,
  verifyPassword,
} from '../server/utils/crypto'

describe('crypto utilities', () => {
  it('hashes and verifies passwords using the production implementation', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^scrypt:[0-9a-f]{64}:[0-9a-f]{128}$/)
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false)
  })

  it('supports legacy scrypt hashes', async () => {
    const hash = await hashPassword('legacy password')
    await expect(
      verifyPassword('legacy password', hash.replace(/^scrypt:/, '')),
    ).resolves.toBe(true)
  })

  it('supports algorithm-prefixed PBKDF2 hashes', async () => {
    const salt = 'ab'.repeat(32)
    const key = await promisify(pbkdf2)(
      Buffer.from('pbkdf2 password'),
      salt,
      600_000,
      64,
      'sha256',
    )
    await expect(
      verifyPassword(
        'pbkdf2 password',
        `pbkdf2:${salt}:${key.toString('hex')}`,
      ),
    ).resolves.toBe(true)
  })

  it.each([
    '',
    'invalid',
    'scrypt:missing',
    'unknown:aa:bb',
    'scrypt:not-hex:00',
    `scrypt:${'aa'.repeat(32)}:01`,
    `scrypt:${'aa'.repeat(32)}:${'gg'.repeat(64)}`,
  ])('returns false for malformed hash %j', async (hash) => {
    await expect(verifyPassword('password', hash)).resolves.toBe(false)
  })

  it('generates unique 96-character session tokens', () => {
    const first = generateSessionToken()
    const second = generateSessionToken()
    expect(first).toMatch(/^[0-9a-f]{96}$/)
    expect(second).toMatch(/^[0-9a-f]{96}$/)
    expect(first).not.toBe(second)
  })

  it('compares equal strings without accepting different values or lengths', () => {
    expect(safeCompare('hello', 'hello')).toBe(true)
    expect(safeCompare('hello', 'world')).toBe(false)
    expect(safeCompare('hello', 'hell')).toBe(false)
  })
})
