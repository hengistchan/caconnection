import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashRecoveryCode } from '../server/utils/totp'
import {
  consumeRecoveryCode,
  getRemainingRecoveryCodeCount,
  validateTotpStateFile,
} from '../server/utils/totp-state'

describe('persistent TOTP recovery-code state', () => {
  let directory: string
  let statePath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'admin-totp-state-'))
    statePath = join(directory, 'totp-state.json')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      recoveryCodeHashes: [
        hashRecoveryCode('ABCDEF1234ABCDEF1234'),
        hashRecoveryCode('1234567890ABCDEF1234'),
      ],
    }))
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('persists one-time consumption across subsequent file reads', () => {
    validateTotpStateFile(statePath)
    expect(consumeRecoveryCode(statePath, 'ABCD-EF12-34AB-CDEF-1234')).toBe(true)
    expect(consumeRecoveryCode(statePath, 'ABCDEF1234ABCDEF1234')).toBe(false)
    expect(getRemainingRecoveryCodeCount(statePath)).toBe(1)
    expect(readFileSync(statePath, 'utf8')).not.toContain('ABCDEF1234ABCDEF1234')
  })

  it('rejects malformed state instead of silently disabling recovery codes', () => {
    writeFileSync(statePath, '{"version":1,"recoveryCodeHashes":["plaintext"]}')
    expect(() => validateTotpStateFile(statePath)).toThrow('Invalid TOTP state')
  })
})
