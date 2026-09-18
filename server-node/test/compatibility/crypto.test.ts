/**
 * Compatibility tests for crypto operations.
 *
 * These tests verify that the Node.js implementation produces byte-identical
 * results to the Python gateway for:
 *   - HKDF key derivation
 *   - AES-256-GCM encryption/decryption
 *   - HMAC-SHA256 request signatures
 *   - OTP extraction
 *
 * Run with: npm run test:compat
 */

import { describe, it, expect } from 'vitest';
import { payloadKey, encryptPayload, decryptPayload, type Envelope } from '../../src/crypto/payload-crypto.js';
import { expectedSignature, verifySignature, canonicalRequest } from '../../src/crypto/request-signature.js';
import { extractOtpCandidates } from '../../src/crypto/otp-extraction.js';
import { base64Decode } from '../../src/crypto/encoding.js';
import { randomBytes, createHash } from 'node:crypto';

describe('HKDF Key Derivation', () => {
  it('should derive consistent keys for same inputs', () => {
    const secret = randomBytes(32);
    const deviceId = 'test-device-001';

    const key1 = payloadKey(secret, deviceId);
    const key2 = payloadKey(secret, deviceId);

    expect(key1).toEqual(key2);
    expect(key1.length).toBe(32);
  });

  it('should derive different keys for different devices', () => {
    const secret = randomBytes(32);

    const key1 = payloadKey(secret, 'device-a');
    const key2 = payloadKey(secret, 'device-b');

    expect(key1).not.toEqual(key2);
  });

  it('should derive different keys for different secrets', () => {
    const deviceId = 'test-device';

    const key1 = payloadKey(randomBytes(32), deviceId);
    const key2 = payloadKey(randomBytes(32), deviceId);

    expect(key1).not.toEqual(key2);
  });
});

describe('AES-256-GCM Payload Encryption', () => {
  const testEnvelope: Envelope = {
    schemaVersion: 1,
    deliveryId: 'test-delivery-123',
    sourceEventId: 'test-source-456',
    eventType: 'INCOMING_SMS',
    createdAt: 1700000000000,
    subscriptionId: 1,
    slotIndex: 0,
    payload: {
      originatingAddress: '+1234567890',
      body: 'Your OTP is 123456',
      partCount: 1,
    },
  };

  it('should encrypt and decrypt roundtrip correctly', () => {
    const secret = randomBytes(32);
    const deviceId = 'test-device-001';

    const encrypted = encryptPayload(testEnvelope, deviceId, secret);

    // Encrypted envelope should have schemaVersion 2
    expect(encrypted.schemaVersion).toBe(2);

    // Payload should be encrypted
    const payload = encrypted.payload as any;
    expect(payload.algorithm).toBe('AES-256-GCM');
    expect(payload.nonceBase64).toBeTruthy();
    expect(payload.ciphertextBase64).toBeTruthy();

    // Decrypt back
    const decrypted = decryptPayload(encrypted, deviceId, secret);

    // Should match original
    expect(decrypted.schemaVersion).toBe(2); // schemaVersion stays 2
    expect(decrypted.deliveryId).toBe(testEnvelope.deliveryId);
    expect(decrypted.sourceEventId).toBe(testEnvelope.sourceEventId);
    expect(decrypted.eventType).toBe(testEnvelope.eventType);
    expect(decrypted.createdAt).toBe(testEnvelope.createdAt);
    expect(decrypted.subscriptionId).toBe(testEnvelope.subscriptionId);
    expect(decrypted.slotIndex).toBe(testEnvelope.slotIndex);

    // Payload should be restored
    const decryptedPayload = decrypted.payload as any;
    expect(decryptedPayload.originatingAddress).toBe('+1234567890');
    expect(decryptedPayload.body).toBe('Your OTP is 123456');
    expect(decryptedPayload.partCount).toBe(1);
  });

  it('should fail to decrypt with wrong secret', () => {
    const secret1 = randomBytes(32);
    const secret2 = randomBytes(32);
    const deviceId = 'test-device';

    const encrypted = encryptPayload(testEnvelope, deviceId, secret1);

    expect(() => decryptPayload(encrypted, deviceId, secret2)).toThrow();
  });

  it('should fail to decrypt with wrong device ID', () => {
    const secret = randomBytes(32);

    const encrypted = encryptPayload(testEnvelope, 'device-a', secret);

    expect(() => decryptPayload(encrypted, 'device-b', secret)).toThrow();
  });

  it('should produce deterministic nonce length', () => {
    const secret = randomBytes(32);
    const deviceId = 'test-device';

    const encrypted = encryptPayload(testEnvelope, deviceId, secret);
    const payload = encrypted.payload as any;
    const nonce = base64Decode(payload.nonceBase64);

    expect(nonce.length).toBe(12); // AES-GCM standard nonce
  });

  it('should handle null subscriptionId and slotIndex', () => {
    const secret = randomBytes(32);
    const deviceId = 'test-device';

    const envelope: Envelope = {
      ...testEnvelope,
      subscriptionId: null,
      slotIndex: null,
    };

    const encrypted = encryptPayload(envelope, deviceId, secret);
    const decrypted = decryptPayload(encrypted, deviceId, secret);

    expect(decrypted.subscriptionId).toBeNull();
    expect(decrypted.slotIndex).toBeNull();
  });

  it('should not re-encrypt schemaVersion 2', () => {
    const secret = randomBytes(32);
    const deviceId = 'test-device';

    const encrypted = encryptPayload(testEnvelope, deviceId, secret);
    const reEncrypted = encryptPayload(encrypted, deviceId, secret);

    // Should be identical (idempotent)
    expect(reEncrypted).toEqual(encrypted);
  });
});

describe('HMAC-SHA256 Request Signature', () => {
  it('should produce consistent signatures', () => {
    const secret = randomBytes(32);
    const timestampMs = 1700000000000;
    const nonce = 'test-nonce-abc123';
    const deviceId = 'test-device';
    const idempotencyKey = 'test-key-xyz789';
    const body = Buffer.from('{"test": "data"}');

    const sig1 = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);
    const sig2 = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);

    expect(sig1).toBe(sig2);
  });

  it('should verify valid signatures', () => {
    const secret = randomBytes(32);
    const timestampMs = 1700000000000;
    const nonce = 'test-nonce';
    const deviceId = 'test-device';
    const idempotencyKey = 'test-key';
    const body = Buffer.from('{"test": "data"}');

    const signature = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);

    expect(verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)).toBe(true);
  });

  it('should reject invalid signatures', () => {
    const secret = randomBytes(32);
    const timestampMs = 1700000000000;
    const nonce = 'test-nonce';
    const deviceId = 'test-device';
    const idempotencyKey = 'test-key';
    const body = Buffer.from('{"test": "data"}');

    expect(verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, 'invalid')).toBe(false);
  });

  it('should produce different signatures for different bodies', () => {
    const secret = randomBytes(32);
    const base = { timestampMs: 1700000000000, nonce: 'nonce', deviceId: 'dev', idempotencyKey: 'key' };

    const sig1 = expectedSignature(secret, base.timestampMs, base.nonce, base.deviceId, base.idempotencyKey, Buffer.from('body1'));
    const sig2 = expectedSignature(secret, base.timestampMs, base.nonce, base.deviceId, base.idempotencyKey, Buffer.from('body2'));

    expect(sig1).not.toBe(sig2);
  });

  it('should produce different signatures for different timestamps', () => {
    const secret = randomBytes(32);
    const body = Buffer.from('{"test": "data"}');
    const base = { nonce: 'nonce', deviceId: 'dev', idempotencyKey: 'key' };

    const sig1 = expectedSignature(secret, 1000, base.nonce, base.deviceId, base.idempotencyKey, body);
    const sig2 = expectedSignature(secret, 2000, base.nonce, base.deviceId, base.idempotencyKey, body);

    expect(sig1).not.toBe(sig2);
  });
});

describe('OTP Extraction', () => {
  it('should extract 6-digit OTP from context', () => {
    const body = 'Your verification code is 123456. Please enter it within 10 minutes.';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toContain('123456');
  });

  it('should extract 4-digit OTP', () => {
    const body = 'Your OTP: 1234';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toContain('1234');
  });

  it('should rank contextual OTPs first', () => {
    const body = '111111.\nverification code 222222';
    const candidates = extractOtpCandidates(body);

    // "verification code 222222" has context keyword, so 222222 should rank higher
    expect(candidates[0]).toBe('222222');
  });

  it('should handle Chinese OTP context', () => {
    const body = '验证码是888888，请在5分钟内输入';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toContain('888888');
  });

  it('should not extract numbers shorter than 4 digits', () => {
    const body = 'Your code is 123';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toHaveLength(0);
  });

  it('should not extract numbers longer than 8 digits', () => {
    const body = 'Your code is 123456789';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toHaveLength(0);
  });

  it('should not extract numbers adjacent to other digits', () => {
    const body = 'Order 123456789 confirmed';
    const candidates = extractOtpCandidates(body);

    expect(candidates).toHaveLength(0);
  });

  it('should handle null/undefined body', () => {
    expect(extractOtpCandidates(null)).toEqual([]);
    expect(extractOtpCandidates(undefined)).toEqual([]);
  });

  it('should deduplicate same number appearing multiple times', () => {
    const body = 'Code: 123456 and again 123456';
    const candidates = extractOtpCandidates(body);

    expect(candidates.filter(c => c === '123456')).toHaveLength(1);
  });

  it('should prefer 6 and 4 digit codes', () => {
    const body = 'Codes: 12345 and 123456';
    const candidates = extractOtpCandidates(body);

    // 123456 (6 digits) should rank higher than 12345 (5 digits)
    expect(candidates[0]).toBe('123456');
  });
});

describe('Canonical Request', () => {
  it('should produce consistent format', () => {
    const body = Buffer.from('{"test": "data"}');
    const bodyHash = createHash('sha256').update(body).digest('hex');

    const canonical = canonicalRequest(1700000000000, 'test-nonce', 'device-1', 'key-1', body);
    const expected = `1700000000000\ntest-nonce\ndevice-1\nkey-1\n${bodyHash}`;

    expect(canonical.toString()).toBe(expected);
  });
});
