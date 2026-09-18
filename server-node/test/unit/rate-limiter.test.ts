/**
 * Tests for the sliding window rate limiter.
 */

import { describe, it, expect } from 'vitest';
import { SlidingWindowRateLimiter } from '../../src/auth/rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('should allow requests within limit', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    const result = limiter.allow('test', 'key', 10, now);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('should reject requests over limit', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Fill the limit
    for (let i = 0; i < 5; i++) {
      limiter.allow('test', 'key', 5, now + i);
    }

    // Should be rejected
    const result = limiter.allow('test', 'key', 5, now + 5);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should allow requests after window expires', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Fill the limit
    for (let i = 0; i < 5; i++) {
      limiter.allow('test', 'key', 5, now + i);
    }

    // After 60 seconds, should be allowed
    const result = limiter.allow('test', 'key', 5, now + 60_001);
    expect(result.allowed).toBe(true);
  });

  it('should track different keys independently', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Fill limit for key-a
    for (let i = 0; i < 5; i++) {
      limiter.allow('test', 'key-a', 5, now + i);
    }

    // key-b should still be allowed
    const result = limiter.allow('test', 'key-b', 5, now);
    expect(result.allowed).toBe(true);
  });

  it('should track different buckets independently', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Fill limit for bucket-a
    for (let i = 0; i < 5; i++) {
      limiter.allow('bucket-a', 'key', 5, now + i);
    }

    // bucket-b should still be allowed
    const result = limiter.allow('bucket-b', 'key', 5, now);
    expect(result.allowed).toBe(true);
  });

  it('should always allow when limit is zero', () => {
    const limiter = new SlidingWindowRateLimiter();
    const result = limiter.allow('test', 'key', 0, 1000000);
    expect(result.allowed).toBe(true);
  });

  it('should return correct retry-after time', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Add one request
    limiter.allow('test', 'key', 1, now);

    // Should be rejected with retry-after
    const result = limiter.allow('test', 'key', 1, now + 1000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(60_000 - 1000);
  });

  it('should handle cleanup correctly', () => {
    const limiter = new SlidingWindowRateLimiter();
    const now = 1000000;

    // Add old requests
    for (let i = 0; i < 5; i++) {
      limiter.allow('test', 'old-key', 10, now - 120_000 + i);
    }

    // Trigger cleanup
    limiter.allow('test', 'new-key', 10, now + 60_001);

    // Old entries should be cleaned up
    const result = limiter.allow('test', 'old-key', 10, now + 60_002);
    expect(result.allowed).toBe(true);
  });
});
