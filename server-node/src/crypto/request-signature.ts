/**
 * HMAC-SHA256 request signature verification.
 *
 * Canonical request format (newline-joined):
 *   timestamp_ms
 *   nonce
 *   device_id
 *   idempotency_key
 *   sha256_hex(body)
 *
 * Signature: Base64(HMAC-SHA256(secret, canonical_request))
 *
 * MUST match the Python gateway byte-for-byte.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { base64Encode } from './encoding.js';

/**
 * Build the canonical request bytes for signing.
 */
export function canonicalRequest(
  timestampMs: number,
  nonce: string,
  deviceId: string,
  idempotencyKey: string,
  body: Buffer,
): Buffer {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const parts = [
    String(timestampMs),
    nonce,
    deviceId,
    idempotencyKey,
    bodyHash,
  ];
  return Buffer.from(parts.join('\n'), 'utf-8');
}

/**
 * Compute the expected HMAC-SHA256 signature as Base64.
 */
export function expectedSignature(
  secret: Buffer,
  timestampMs: number,
  nonce: string,
  deviceId: string,
  idempotencyKey: string,
  body: Buffer,
): string {
  const canonical = canonicalRequest(timestampMs, nonce, deviceId, idempotencyKey, body);
  const digest = createHmac('sha256', secret).update(canonical).digest();
  return base64Encode(digest);
}

/**
 * Verify a request signature using timing-safe comparison.
 * Returns true if the signature is valid.
 */
export function verifySignature(
  secret: Buffer,
  timestampMs: number,
  nonce: string,
  deviceId: string,
  idempotencyKey: string,
  body: Buffer,
  providedSignature: string,
): boolean {
  const expected = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);

  // Both must be same length for timingSafeEqual
  if (expected.length !== providedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expected, 'utf-8'),
    Buffer.from(providedSignature, 'utf-8'),
  );
}
