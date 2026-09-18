/**
 * Device HMAC authentication.
 *
 * Verifies Android device requests using:
 *   - X-Gateway-Device header
 *   - X-Gateway-Timestamp header (millisecond timestamp)
 *   - X-Gateway-Nonce header (1-128 chars)
 *   - X-Gateway-Signature header (HMAC-SHA256 Base64)
 *   - Idempotency-Key header (1-128 chars)
 *
 * Must match the Python gateway's authorize_device_request exactly.
 */

import { verifySignature } from '../crypto/request-signature.js';
import { MAX_CLOCK_SKEW_MS } from '../config/constants.js';
import { AuthenticationError, RateLimitError } from './auth-errors.js';
import type { SlidingWindowRateLimiter } from './rate-limiter.js';
import type { DeviceRepository } from '../repositories/device-repository.js';

export interface DeviceAuthHeaders {
  deviceId: string;
  timestampMs: number;
  nonce: string;
  idempotencyKey: string;
  signature: string;
}

/**
 * Parse device authentication headers from a request.
 */
export function parseDeviceAuthHeaders(headers: Record<string, string | string[] | undefined>): DeviceAuthHeaders {
  const deviceId = getHeader(headers, 'x-gateway-device');
  const timestampStr = getHeader(headers, 'x-gateway-timestamp');
  const nonce = getHeader(headers, 'x-gateway-nonce');
  const idempotencyKey = getHeader(headers, 'idempotency-key');
  const signature = getHeader(headers, 'x-gateway-signature');

  if (!deviceId || !timestampStr || !nonce || !idempotencyKey || !signature) {
    throw new AuthenticationError('missing required device auth headers');
  }

  const timestampMs = parseInt(timestampStr, 10);
  if (isNaN(timestampMs)) {
    throw new AuthenticationError('invalid timestamp');
  }

  return { deviceId, timestampMs, nonce, idempotencyKey, signature };
}

/**
 * Verify a device request.
 *
 * Returns the device secret if authentication succeeds.
 * Throws AuthenticationError or RateLimitError on failure.
 */
export function verifyDeviceRequest(
  headers: DeviceAuthHeaders,
  body: Buffer,
  nowMs: number,
  secrets: Map<string, Buffer>,
  deviceRepo: DeviceRepository,
  rateLimiter: SlidingWindowRateLimiter,
  clientIp: string,
  ingestRateLimit: number,
  deviceRateLimit: number,
): Buffer {
  // Check IP-based ingest rate limit
  const ipResult = rateLimiter.allow('ingest-ip', clientIp, ingestRateLimit, nowMs);
  if (!ipResult.allowed) {
    throw new RateLimitError(ipResult.retryAfterMs);
  }

  const { deviceId, timestampMs, nonce, idempotencyKey, signature } = headers;

  // Validate header lengths
  if (nonce.length < 1 || nonce.length > 128) {
    throw new AuthenticationError('invalid nonce');
  }
  if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
    throw new AuthenticationError('invalid idempotency key');
  }
  if (signature.length < 1 || signature.length > 128) {
    throw new AuthenticationError('invalid signature');
  }

  // Check device exists
  const secret = secrets.get(deviceId);
  if (!secret) {
    throw new AuthenticationError('authentication failed');
  }

  // Check device is active
  if (!deviceRepo.isActive(deviceId)) {
    throw new AuthenticationError('authentication failed');
  }

  // Check clock skew
  if (Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw new AuthenticationError('authentication failed');
  }

  // Verify signature
  if (!verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)) {
    throw new AuthenticationError('authentication failed');
  }

  // Check device rate limit
  const deviceResult = rateLimiter.allow('device', deviceId, deviceRateLimit, nowMs);
  if (!deviceResult.allowed) {
    throw new RateLimitError(deviceResult.retryAfterMs);
  }

  // Record nonce (throws if replayed)
  deviceRepo.recordNonce(deviceId, nonce, nowMs);

  // Touch device last_seen_at
  deviceRepo.touchDevice(deviceId, nowMs);

  return secret;
}

/**
 * Get a single header value (case-insensitive).
 */
function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
