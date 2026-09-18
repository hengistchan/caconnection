/**
 * Integration tests for OtpRepository.
 *
 * Tests OTP claim logic, atomicity, and filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventRepository } from '../../../src/repositories/event-repository.js';
import { OtpRepository } from '../../../src/repositories/otp-repository.js';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { encryptPayload } from '../../../src/crypto/payload-crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'otp-repo-test-'));
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

function generateSecret(): Buffer {
  return randomBytes(32);
}

describe('OtpRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let eventRepo: EventRepository;
  let otpRepo: OtpRepository;
  let deviceRepo: DeviceRepository;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    eventRepo = new EventRepository(db);
    otpRepo = new OtpRepository(db);
    deviceRepo = new DeviceRepository(db);

    // Create test devices
    const secret = generateSecret();
    deviceRepo.add('device-1', secret.toString('base64'), 'Device 1', 1000000);
    const secret2 = generateSecret();
    deviceRepo.add('device-2', secret2.toString('base64'), 'Device 2', 1000000);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertOtpEvent(
    deviceId: string,
    body: string,
    receivedAt: number,
    slotIndex: number = 0,
    deliveryId?: string,
  ) {
    const secret = deviceRepo.loadSecrets().get(deviceId)!;
    const envelope = encryptPayload(
      {
        schemaVersion: 1,
        deliveryId: deliveryId || `d-${receivedAt}-${Math.random()}`,
        sourceEventId: `s-${receivedAt}`,
        eventType: 'INCOMING_SMS',
        createdAt: receivedAt,
        subscriptionId: null,
        slotIndex,
        payload: { body, originatingAddress: '+1234567890' },
      },
      deviceId,
      secret,
    );
    return eventRepo.accept(deviceId, `key-${receivedAt}-${Math.random()}`, `nonce-${receivedAt}-${Math.random()}`, envelope, receivedAt);
  }

  describe('claimLatest', () => {
    it('should claim the latest unclaimed OTP', () => {
      insertOtpEvent('device-1', 'Your code is 123456', 1000000);
      insertOtpEvent('device-1', 'Your code is 789012', 1000001);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000002, 600);

      expect(claim).not.toBeNull();
      expect(claim!.code).toBe('789012'); // Most recent
      expect(claim!.deviceId).toBe('device-1');
    });

    it('should not claim the same OTP twice', () => {
      insertOtpEvent('device-1', 'Your code is 123456', 1000000);

      const secrets = deviceRepo.loadSecrets();
      const firstClaim = otpRepo.claimLatest(secrets, 'client-1', 1000001, 600);
      expect(firstClaim).not.toBeNull();

      const secondClaim = otpRepo.claimLatest(secrets, 'client-2', 1000002, 600);
      expect(secondClaim).toBeNull(); // Already claimed
    });

    it('should filter by deviceId', () => {
      insertOtpEvent('device-1', 'Code 111111', 1000000);
      insertOtpEvent('device-2', 'Code 222222', 1000001);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000002, 600, { deviceId: 'device-1' });

      expect(claim).not.toBeNull();
      expect(claim!.code).toBe('111111');
      expect(claim!.deviceId).toBe('device-1');
    });

    it('should filter by deviceIds set', () => {
      insertOtpEvent('device-1', 'Code 111111', 1000000);
      insertOtpEvent('device-2', 'Code 222222', 1000001);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000002, 600, { deviceIds: new Set(['device-2']) });

      expect(claim).not.toBeNull();
      expect(claim!.code).toBe('222222');
      expect(claim!.deviceId).toBe('device-2');
    });

    it('should filter by slotIndex', () => {
      insertOtpEvent('device-1', 'Code 111111', 1000000, 0);
      insertOtpEvent('device-1', 'Code 222222', 1000001, 1);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000002, 600, { slotIndex: 0 });

      expect(claim).not.toBeNull();
      expect(claim!.code).toBe('111111');
      expect(claim!.slotIndex).toBe(0);
    });

    it('should filter by eventId', () => {
      insertOtpEvent('device-1', 'Code 111111', 1000000);
      insertOtpEvent('device-1', 'Code 222222', 1000001);

      // Get the event IDs
      const events = db.prepare('SELECT id FROM events ORDER BY received_at').all() as { id: number }[];

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000002, 600, { eventId: events[0].id });

      expect(claim).not.toBeNull();
      expect(claim!.code).toBe('111111');
      expect(claim!.eventId).toBe(events[0].id);
    });

    it('should respect maxAgeSeconds', () => {
      const now = Date.now();
      insertOtpEvent('device-1', 'Code 111111', now - 5000); // 5 seconds ago

      const secrets = deviceRepo.loadSecrets();

      // With large max age (10 seconds), should find the event
      const claim1 = otpRepo.claimLatest(secrets, 'client-1', now, 10);
      expect(claim1!.code).toBe('111111');

      // Insert another event
      insertOtpEvent('device-1', 'Code 222222', now - 1000); // 1 second ago

      // With small max age (2 seconds), should only find recent
      const claim2 = otpRepo.claimLatest(secrets, 'client-2', now, 2);
      expect(claim2!.code).toBe('222222');
    });

    it('should return null when no OTP found', () => {
      // Insert non-OTP message
      const secret = deviceRepo.loadSecrets().get('device-1')!;
      const envelope = encryptPayload(
        {
          schemaVersion: 1,
          deliveryId: 'd1',
          sourceEventId: 's1',
          eventType: 'INCOMING_SMS',
          createdAt: 1000000,
          subscriptionId: null,
          slotIndex: 0,
          payload: { body: 'Hello world', originatingAddress: '+1234567890' },
        },
        'device-1',
        secret,
      );
      eventRepo.accept('device-1', 'key-1', 'nonce-1', envelope, 1000000);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000001, 600);

      expect(claim).toBeNull();
    });

    it('should handle concurrent claims atomically', () => {
      insertOtpEvent('device-1', 'Code 123456', 1000000);

      const secrets = deviceRepo.loadSecrets();

      // Simulate concurrent claims
      const results: Array<string | null> = [];
      for (let i = 0; i < 5; i++) {
        try {
          const claim = otpRepo.claimLatest(secrets, `client-${i}`, 1000001, 600);
          results.push(claim?.code ?? null);
        } catch {
          results.push(null);
        }
      }

      // Only one should succeed
      const successful = results.filter(r => r !== null);
      expect(successful).toHaveLength(1);
      expect(successful[0]).toBe('123456');
    });

    it('should return null for empty deviceIds set', () => {
      insertOtpEvent('device-1', 'Code 123456', 1000000);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000001, 600, { deviceIds: new Set() });

      expect(claim).toBeNull();
    });

    it('should include expiresAt in response', () => {
      insertOtpEvent('device-1', 'Code 123456', 1000000);

      const secrets = deviceRepo.loadSecrets();
      const claim = otpRepo.claimLatest(secrets, 'client-1', 1000001, 600);

      expect(claim!.expiresAt).toBe(1000000 + 600 * 1000);
    });
  });
});
