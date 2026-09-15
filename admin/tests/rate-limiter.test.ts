import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkLoginRateLimit,
  getClientIp,
  getTrackedLoginClientCountForTests,
  recordLoginAttempt,
  resetLoginRateLimiterForTests,
} from '../server/utils/rate-limiter'

function request(
  remoteAddress: string,
  headers: Record<string, string> = {},
) {
  return { node: { req: { headers, socket: { remoteAddress } } } }
}

describe('login rate limiter', () => {
  beforeEach(() => {
    resetLoginRateLimiterForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'))
    delete process.env.TRUST_PROXY_HEADERS
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.TRUST_PROXY_HEADERS
  })

  it('blocks after five failures and releases after the block expires', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(checkLoginRateLimit('client').allowed).toBe(true)
      recordLoginAttempt('client')
    }
    expect(checkLoginRateLimit('client').allowed).toBe(false)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    expect(checkLoginRateLimit('client').allowed).toBe(true)
  })

  it('ignores spoofed proxy headers by default', () => {
    expect(getClientIp(request('203.0.113.8', {
      'cf-connecting-ip': '198.51.100.4',
      'x-forwarded-for': '198.51.100.5',
    }))).toBe('203.0.113.8')
  })

  it('trusts validated Cloudflare headers only from a trusted proxy', () => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    expect(getClientIp(request('172.18.0.3', {
      'cf-connecting-ip': '198.51.100.4',
      'x-forwarded-for': '198.51.100.5',
    }))).toBe('198.51.100.4')
    expect(getClientIp(request('203.0.113.8', {
      'cf-connecting-ip': '198.51.100.4',
    }))).toBe('203.0.113.8')
  })

  it('rejects malformed forwarded addresses and enforces a hard cap', () => {
    process.env.TRUST_PROXY_HEADERS = 'true'
    expect(getClientIp(request('127.0.0.1', {
      'cf-connecting-ip': 'attacker-controlled',
    }))).toBe('127.0.0.1')

    for (let client = 0; client < 10_050; client += 1) {
      recordLoginAttempt(`client-${client}`)
    }
    expect(getTrackedLoginClientCountForTests()).toBe(10_000)
  })
})
