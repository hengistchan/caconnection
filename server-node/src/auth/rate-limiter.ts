/**
 * Sliding window rate limiter.
 *
 * MUST match the Python gateway's SlidingWindowRateLimiter exactly:
 *   - 60-second sliding window
 *   - Per-bucket, per-key tracking
 *   - Periodic cleanup every 60 seconds
 *   - Maximum 10,000identities
 */

import { MAX_RATE_LIMIT_IDENTITIES } from '../config/constants.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private lastCleanupMs: number = 0;

  allow(bucket: string, key: string, limit: number, nowMs: number): RateLimitResult {
    if (limit <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const cutoff = nowMs - 60_000;
    const identity = `${bucket}:${key}`;

    // Periodic cleanup every60 seconds
    if (nowMs - this.lastCleanupMs >= 60_000) {
      for (const [existingIdentity, requests] of this.requests) {
        // Remove expired requests
        while (requests.length > 0 && requests[0]! <= cutoff) {
          requests.shift();
        }
        if (requests.length === 0) {
          this.requests.delete(existingIdentity);
        }
      }
      this.lastCleanupMs = nowMs;
    }

    // Check identity limit
    if (!this.requests.has(identity) && this.requests.size >= MAX_RATE_LIMIT_IDENTITIES) {
      return { allowed: false, retryAfterMs: 60_000 };
    }

    // Get or create request list for this identity
    let requests = this.requests.get(identity);
    if (!requests) {
      requests = [];
      this.requests.set(identity, requests);
    }

    // Remove expired requests
    while (requests.length > 0 && requests[0]! <= cutoff) {
      requests.shift();
    }

    // Check limit
    if (requests.length >= limit) {
      const retryAfterMs = Math.max(1, 60_000 - (nowMs - requests[0]!));
      return { allowed: false, retryAfterMs };
    }

    // Add current request
    requests.push(nowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Clear all rate limit state (for testing).
   */
  clear(): void {
    this.requests.clear();
    this.lastCleanupMs = 0;
  }
}
