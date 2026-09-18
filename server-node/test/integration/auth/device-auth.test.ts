/**
 * Integration tests for device HMAC authentication.
 *
 * Tests the full authentication flow including header parsing, signature verification,
 * rate limiting, and nonce protection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { SlidingWindowRateLimiter } from '../../../src/auth/rate-limiter.js';
import { parseDeviceAuthHeaders, verifyDeviceRequest } from '../../../src/auth/device-auth.js';
import { expectedSignature } from '../../../src/crypto/request-signature.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'device-auth-test-'));
  const db = new DatabaseSync(join(dir, 'test.db'), {
    open: true,
    enableForeignKeyConstraints: true,
    readOnly: false,
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  initializeDatabase(db);
  return { db, dir };
}

describe('Device Authentication', () => {
  let db: DatabaseSync;
  let dir: string;
  let deviceRepo: DeviceRepository;
  let rateLimiter: SlidingWindowRateLimiter;
  let secret: Buffer;
  let deviceId: string;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    deviceRepo = new DeviceRepository(db);
    rateLimiter = new SlidingWindowRateLimiter();

    secret = randomBytes(32);
    deviceId = 'test-device';
    deviceRepo.add(deviceId, secret.toString('base64'), 'Test device', Date.now());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function createAuthHeaders(
    body: Buffer,
    overrides: Partial<{
      deviceId: string;
      timestampMs: number;
      nonce: string;
      idempotencyKey: string;
    }> = {},
  ) {
    const id = overrides.deviceId ?? deviceId;
    const ts = overrides.timestampMs ?? Date.now();
    const nonce = overrides.nonce ?? `nonce-${randomBytes(8).toString('hex')}`;
    const idKey = overrides.idempotencyKey ?? `key-${randomBytes(8).toString('hex')}`;
    const sig = expectedSignature(secret, ts, nonce, id, idKey, body);

    return {
      'x-gateway-device': id,
      'x-gateway-timestamp': String(ts),
      'x-gateway-nonce': nonce,
      'idempotency-key': idKey,
      'x-gateway-signature': sig,
    };
  }

  describe('parseDeviceAuthHeaders', () => {
    it('should parse valid headers', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body);

      const parsed = parseDeviceAuthHeaders(headers);

      expect(parsed.deviceId).toBe(deviceId);
      expect(parsed.nonce).toBeDefined();
      expect(parsed.idempotencyKey).toBeDefined();
      expect(parsed.signature).toBeDefined();
    });

    it('should throw on missing headers', () => {
      expect(() => parseDeviceAuthHeaders({})).toThrow('missing required device auth headers');
    });

    it('should throw on invalid timestamp', () => {
      const headers = {
        'x-gateway-device': deviceId,
        'x-gateway-timestamp': 'not-a-number',
        'x-gateway-nonce': 'nonce',
        'idempotency-key': 'key',
        'x-gateway-signature': 'sig',
      };

      expect(() => parseDeviceAuthHeaders(headers)).toThrow('invalid timestamp');
    });
  });

  describe('verifyDeviceRequest', () => {
    it('should verify a valid request', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body);
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      const result = verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      );

      expect(result).toEqual(secret);
    });

    it('should throw on unknown device', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body, { deviceId: 'unknown-device' });
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('authentication failed');
    });

    it('should throw on retired device', () => {
      deviceRepo.retire(deviceId, Date.now());

      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body);
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('authentication failed');
    });

    it('should throw on clock skew > 5 minutes', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body, { timestampMs: Date.now() - 300001 });
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('authentication failed');
    });

    it('should throw on invalid signature', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body);
      headers['x-gateway-signature'] = 'invalid-signature';
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('authentication failed');
    });

    it('should throw on replayed nonce', () => {
      const body = Buffer.from('{"test": "data"}');
      const nonce = 'fixed-nonce';
      const headers = createAuthHeaders(body, { nonce });
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      // First request should succeed
      verifyDeviceRequest(parsed, body, Date.now(), secrets, deviceRepo, rateLimiter, '127.0.0.1', 120, 120);

      // Second request with same nonce should fail
      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('replayed nonce');
    });

    it('should enforce IP-based ingest rate limit', () => {
      const body = Buffer.from('{"test": "data"}');
      const secrets = new Map([[deviceId, secret]]);

      // Exhaust rate limit
      for (let i = 0; i < 10; i++) {
        const headers = createAuthHeaders(body);
        const parsed = parseDeviceAuthHeaders(headers);
        try {
          verifyDeviceRequest(parsed, body, Date.now(), secrets, deviceRepo, rateLimiter, '127.0.0.1', 10, 120);
        } catch {
          // Ignore nonce errors
        }
      }

      // Next request should be rate limited
      const headers = createAuthHeaders(body);
      const parsed = parseDeviceAuthHeaders(headers);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        10,
        120,
      )).toThrow('rate limit exceeded');
    });

    it('should enforce device-based rate limit', () => {
      const body = Buffer.from('{"test": "data"}');
      const secrets = new Map([[deviceId, secret]]);

      // Exhaust device rate limit
      for (let i = 0; i < 5; i++) {
        const headers = createAuthHeaders(body);
        const parsed = parseDeviceAuthHeaders(headers);
        try {
          verifyDeviceRequest(parsed, body, Date.now(), secrets, deviceRepo, rateLimiter, `127.0.0.${i}`, 120, 5);
        } catch {
          // Ignore nonce errors
        }
      }

      // Next request should be rate limited
      const headers = createAuthHeaders(body);
      const parsed = parseDeviceAuthHeaders(headers);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.100',
        120,
        5,
      )).toThrow('rate limit exceeded');
    });

    it('should touch device last_seen_at on success', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body);
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);
      const now = Date.now();

      verifyDeviceRequest(parsed, body, now, secrets, deviceRepo, rateLimiter, '127.0.0.1', 120, 120);

      const device = deviceRepo.getById(deviceId);
      expect(device!.lastSeenAt).toBe(now);
    });

    it('should reject nonce shorter than 1 character', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = {
        'x-gateway-device': deviceId,
        'x-gateway-timestamp': String(Date.now()),
        'x-gateway-nonce': '',
        'idempotency-key': 'key-123',
        'x-gateway-signature': 'sig-123',
      };
      const secrets = new Map([[deviceId, secret]]);

      // Empty nonce should fail header parsing
      expect(() => {
        const parsed = parseDeviceAuthHeaders(headers);
        verifyDeviceRequest(
          parsed,
          body,
          Date.now(),
          secrets,
          deviceRepo,
          rateLimiter,
          '127.0.0.1',
          120,
          120,
        );
      }).toThrow();
    });

    it('should reject nonce longer than 128 characters', () => {
      const body = Buffer.from('{"test": "data"}');
      const headers = createAuthHeaders(body, { nonce: 'x'.repeat(129) });
      const parsed = parseDeviceAuthHeaders(headers);
      const secrets = new Map([[deviceId, secret]]);

      expect(() => verifyDeviceRequest(
        parsed,
        body,
        Date.now(),
        secrets,
        deviceRepo,
        rateLimiter,
        '127.0.0.1',
        120,
        120,
      )).toThrow('invalid nonce');
    });
  });
});