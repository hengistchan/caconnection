import { createHash, createHmac, randomBytes } from 'node:crypto'
import { safeCompare } from './crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_DIGITS = 6
const TOTP_PERIOD_MS = 30_000
const TOTP_WINDOW = 1
const TOTP_SECRET_BYTES = 20
const RECOVERY_CODE_BYTES = 10

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/=+$/, '').toUpperCase()
  let bits = ''
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid base32 secret')
    bits += index.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  }
  return Buffer.from(bytes)
}

function encodeBase32(value: Buffer): string {
  let bits = ''
  for (const byte of value) bits += byte.toString(2).padStart(8, '0')
  let result = ''
  for (let index = 0; index < bits.length; index += 5) {
    result += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)]
  }
  return result
}

function generateCode(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return value.toString().padStart(TOTP_DIGITS, '0')
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES))
}

export function isValidTotpSecret(secret: string): boolean {
  if (!/^[A-Z2-7]{32}$/i.test(secret)) return false
  try {
    return decodeBase32(secret).length === TOTP_SECRET_BYTES
  } catch {
    return false
  }
}

export function verifyTotpCode(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code) || !isValidTotpSecret(secret)) return false
  let decoded: Buffer
  try {
    decoded = decodeBase32(secret)
  } catch {
    return false
  }
  const counter = Math.floor(now / TOTP_PERIOD_MS)
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    if (safeCompare(generateCode(decoded, counter + offset), code)) return true
  }
  return false
}

export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error('Invalid recovery-code count')
  }
  return Array.from(
    { length: count },
    () => randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase(),
  )
}

export function normalizeRecoveryCode(code: string): string | null {
  const normalized = code.replace(/[\s-]+/g, '').toUpperCase()
  return /^[A-F0-9]{20}$/.test(normalized) ? normalized : null
}

export function hashRecoveryCode(code: string): string | null {
  const normalized = normalizeRecoveryCode(code)
  return normalized
    ? createHash('sha256').update(normalized, 'utf8').digest('hex')
    : null
}

export function verifyRecoveryCodeHash(code: string, expectedHash: string): boolean {
  const actualHash = hashRecoveryCode(code)
  return actualHash !== null
    && /^[0-9a-f]{64}$/i.test(expectedHash)
    && safeCompare(actualHash, expectedHash.toLowerCase())
}
