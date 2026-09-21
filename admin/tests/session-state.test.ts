import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getSessionGeneration,
  isSessionRevoked,
  revokeSession,
  validateSessionStateFile,
} from '../server/utils/session-state'

describe('persistent session state', () => {
  let directory: string
  let statePath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'session-state-'))
    statePath = join(directory, 'session-state.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates a secure initial state and persists revocations', () => {
    expect(getSessionGeneration(statePath)).toBe(1)
    revokeSession(statePath, 'a'.repeat(64), 10_000, 1_000)
    expect(isSessionRevoked(statePath, 'a'.repeat(64), 2_000)).toBe(true)
    expect(isSessionRevoked(statePath, 'a'.repeat(64), 10_001)).toBe(false)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      version: 1,
      generation: 1,
    })
  })

  it('fails closed for malformed state', () => {
    writeFileSync(statePath, '{"version":1,"generation":0,"revokedSessions":{}}')
    expect(() => validateSessionStateFile(statePath)).toThrow(
      'Invalid session state',
    )
  })
})
