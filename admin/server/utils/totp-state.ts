import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifyRecoveryCodeHash } from './totp'

const STATE_VERSION = 1

interface TotpState {
  version: typeof STATE_VERSION
  recoveryCodeHashes: string[]
}

function readState(path: string): TotpState {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TotpState>
  if (
    parsed.version !== STATE_VERSION
    || !Array.isArray(parsed.recoveryCodeHashes)
    || parsed.recoveryCodeHashes.some(hash => (
      typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)
    ))
  ) {
    throw new Error('Invalid TOTP state')
  }
  return {
    version: STATE_VERSION,
    recoveryCodeHashes: [...parsed.recoveryCodeHashes],
  }
}

function writeState(path: string, state: TotpState): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Preserve the original state-write error.
    }
    throw error
  }
}

export function validateTotpStateFile(path: string): void {
  readState(path)
}

export function consumeRecoveryCode(path: string, code: string): boolean {
  const state = readState(path)
  const index = state.recoveryCodeHashes.findIndex(
    hash => verifyRecoveryCodeHash(code, hash),
  )
  if (index < 0) return false
  state.recoveryCodeHashes.splice(index, 1)
  writeState(path, state)
  return true
}

export function getRemainingRecoveryCodeCount(path: string): number {
  return readState(path).recoveryCodeHashes.length
}
