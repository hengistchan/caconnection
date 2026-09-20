import { readFileSync } from 'node:fs'
import { createError } from 'h3'
import { isValidTotpSecret } from './totp'
import { validateTotpStateFile } from './totp-state'

// Cached configuration
let adminConfig: {
  passwordHash: string
  sessionSecret: string
  totpSecret: string | null
  totpStatePath: string | null
} | null = null

/**
 * Load admin configuration
 * Password hash and session secret come from Docker secrets or environment
 */
export function loadAdminConfig(): {
  passwordHash: string
  sessionSecret: string
  totpSecret: string | null
  totpStatePath: string | null
} {
  if (adminConfig) {
    return adminConfig
  }

  let passwordHash: string
  let sessionSecret: string
  let totpSecret: string | null

  // Load password hash
  // Try Docker secret file first (production)
  const passwordHashPath = process.env.ADMIN_PASSWORD_HASH_FILE || '/run/secrets/admin_password_hash'
  try {
    passwordHash = readFileSync(passwordHashPath, 'utf-8').trim()
  } catch {
    // Fall back to environment variable (development/testing only)
    passwordHash = process.env.ADMIN_PASSWORD_HASH || ''
  }

  if (!passwordHash) {
    throw createError({
      statusCode: 500,
      message: 'Admin password hash not configured',
    })
  }

  // Load session secret
  // Try Docker secret file first (production)
  const sessionSecretPath = process.env.ADMIN_SESSION_SECRET_FILE || '/run/secrets/admin_session_secret'
  try {
    sessionSecret = readFileSync(sessionSecretPath, 'utf-8').trim()
  } catch {
    // Fall back to environment variable (development/testing only)
    sessionSecret = process.env.ADMIN_SESSION_SECRET || ''
  }

  if (!sessionSecret) {
    throw createError({
      statusCode: 500,
      message: 'Session secret not configured',
    })
  }

  // Validate hash format
  // New format: algorithm:salt:key (e.g., scrypt:xxx:yyy or pbkdf2:xxx:yyy)
  // Legacy format: salt:key (assumes scrypt)
  const parts = passwordHash.split(':')
  if (parts.length === 3) {
    const [algorithm, salt, key] = parts
    if (
      !['scrypt', 'pbkdf2'].includes(algorithm)
      || !/^[0-9a-f]+$/i.test(salt)
      || !/^[0-9a-f]{128}$/i.test(key)
    ) {
      throw createError({
        statusCode: 500,
        message: 'Invalid admin password hash format',
      })
    }
  } else if (parts.length === 2) {
    const [salt, key] = parts
    if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(key)) {
      throw createError({
        statusCode: 500,
        message: 'Invalid admin password hash format',
      })
    }
  } else {
    throw createError({
      statusCode: 500,
      message: 'Invalid admin password hash format',
    })
  }

  const totpSecretPath = process.env.ADMIN_TOTP_SECRET_FILE || '/run/secrets/admin_totp_secret'
  try {
    totpSecret = readFileSync(totpSecretPath, 'utf-8').trim() || null
  } catch {
    totpSecret = process.env.ADMIN_TOTP_SECRET?.trim() || null
  }
  if (totpSecret && !isValidTotpSecret(totpSecret)) {
    throw createError({ statusCode: 500, message: 'Invalid TOTP secret format' })
  }

  const totpStatePath = totpSecret
    ? process.env.ADMIN_TOTP_STATE_FILE || '/var/lib/caconnection-admin/totp-state.json'
    : null
  if (totpStatePath) {
    try {
      validateTotpStateFile(totpStatePath)
    } catch {
      throw createError({ statusCode: 500, message: 'Invalid TOTP state configuration' })
    }
  }

  // Validate session secret format (hex string)
  if (!/^[0-9a-f]{64}$/i.test(sessionSecret)) {
    throw createError({
      statusCode: 500,
      message: 'Invalid session secret format',
    })
  }

  adminConfig = {
    passwordHash,
    sessionSecret: sessionSecret.toLowerCase(),
    totpSecret,
    totpStatePath,
  }
  return adminConfig
}

/**
 * Clear cached configuration (for testing)
 */
export function clearAdminConfig(): void {
  adminConfig = null
}
