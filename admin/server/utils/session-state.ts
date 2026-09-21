import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const STATE_VERSION = 1

interface SessionState {
  version: typeof STATE_VERSION
  generation: number
  revokedSessions: Record<string, number>
}

function defaultState(): SessionState {
  return {
    version: STATE_VERSION,
    generation: 1,
    revokedSessions: {},
  }
}

function readState(path: string): SessionState {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      const state = defaultState()
      writeState(path, state)
      return state
    }
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<SessionState>
  if (
    parsed.version !== STATE_VERSION
    || !Number.isSafeInteger(parsed.generation)
    || (parsed.generation ?? 0) < 1
    || !isRecord(parsed.revokedSessions)
    || Object.entries(parsed.revokedSessions).some(([id, expiresAt]) => (
      !/^[0-9a-f]{64}$/.test(id)
      || !Number.isSafeInteger(expiresAt)
      || (expiresAt as number) < 0
    ))
  ) {
    throw new Error('Invalid session state')
  }
  return {
    version: STATE_VERSION,
    generation: parsed.generation,
    revokedSessions: { ...parsed.revokedSessions } as Record<string, number>,
  }
}

function writeState(path: string, state: SessionState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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

export function getSessionGeneration(path: string): number {
  return readState(path).generation
}

export function isSessionRevoked(
  path: string,
  sessionId: string,
  now = Date.now(),
): boolean {
  const state = readState(path)
  return (state.revokedSessions[sessionId] ?? 0) > now
}

export function revokeSession(
  path: string,
  sessionId: string,
  expiresAt: number,
  now = Date.now(),
): void {
  const state = readState(path)
  state.revokedSessions = Object.fromEntries(
    Object.entries(state.revokedSessions)
      .filter(([, expiry]) => expiry > now),
  )
  if (expiresAt > now) state.revokedSessions[sessionId] = expiresAt
  writeState(path, state)
}

export function validateSessionStateFile(path: string): void {
  readState(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}
