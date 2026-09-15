import * as crypto from 'node:crypto'
import { promisify } from 'node:util'

const { randomBytes, timingSafeEqual } = crypto
const scrypt = crypto.scrypt

const scryptAsync = promisify(scrypt)

// Constants
const SCRYPT_KEYLEN = 64
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours in milliseconds
const DERIVED_KEY_HEX_LENGTH = SCRYPT_KEYLEN * 2

/**
 * Hash a password using scrypt with random salt
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32).toString('hex')
  const derivedKey = await scryptAsync(
    Buffer.from(password, 'utf-8'),
    salt,
    SCRYPT_KEYLEN,
    {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    }
  )
  return `scrypt:${salt}:${derivedKey.toString('hex')}`
}

/**
 * Verify a password against a stored hash
 * Returns true if password matches, false otherwise
 *
 * Supports both formats:
 * - New: algorithm:salt:key (e.g., scrypt:xxx:yyy or pbkdf2:xxx:yyy)
 * - Legacy: salt:key (assumes scrypt)
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split(':')

  let algorithm: string
  let salt: string
  let keyHex: string

  if (parts.length === 3) {
    // New format: algorithm:salt:key
    [algorithm, salt, keyHex] = parts
  } else if (parts.length === 2) {
    // Legacy format: salt:key (assumes scrypt)
    algorithm = 'scrypt'
    ;[salt, keyHex] = parts
  } else {
    return false
  }

  if (
    !salt
    || !/^[0-9a-f]+$/i.test(salt)
    || !/^[0-9a-f]+$/i.test(keyHex)
    || keyHex.length !== DERIVED_KEY_HEX_LENGTH
  ) {
    return false
  }

  let derivedKey: Buffer

  if (algorithm === 'pbkdf2') {
    // PBKDF2-SHA256
    const pbkdf2Async = promisify(crypto.pbkdf2)
    derivedKey = await pbkdf2Async(
      Buffer.from(password, 'utf-8'),
      salt,
      600000, // iterations
      SCRYPT_KEYLEN,
      'sha256'
    )
  } else if (algorithm === 'scrypt') {
    // Scrypt
    derivedKey = await scryptAsync(
      Buffer.from(password, 'utf-8'),
      salt,
      SCRYPT_KEYLEN,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 128 * 1024 * 1024,
      }
    )
  } else {
    return false
  }

  const storedKey = Buffer.from(keyHex, 'hex')
  return storedKey.length === derivedKey.length
    && timingSafeEqual(derivedKey, storedKey)
}

/**
 * Generate a cryptographically secure random session token
 */
export function generateSessionToken(): string {
  return randomBytes(48).toString('hex')
}

/**
 * Get session maximum age in seconds
 */
export function getSessionMaxAge(): number {
  return SESSION_MAX_AGE / 1000
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}
