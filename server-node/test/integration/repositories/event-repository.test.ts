/**
 * Integration tests for EventRepository.
 *
 * Tests event acceptance, idempotency, nonce protection, message queries, and OTP extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventRepository } from '../../../src/repositories/event-repository.js';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { encryptPayload } from '../../../src/crypto/payload-crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'event-repo-test-'));
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

function createEncryptedEnvelope(
  secret: Buffer,
  deviceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<{
    deliveryId: string;
    sourceEventId: string;
    createdAt: number;
    subscriptionId: number | null;
    slotIndex: number | null;
  }> = {},
) {
  return encryptPayload(
    {
      schemaVersion: 1,
      deliveryId: overrides.deliveryId || `delivery-${Date.now()}`,
      sourceEventId: overrides.sourceEventId || `source-${Date.now()}`,
      eventType,
      createdAt: overrides.createdAt || Date.now(),
      subscriptionId: overrides.subscriptionId ?? null,
      slotIndex: overrides.slotIndex ?? 0,
      payload,
    },
    deviceId,
    secret,
  );
}

describe('EventRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let eventRepo: EventRepository;
  let deviceRepo: DeviceRepository;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    eventRepo = new EventRepository(db);
    deviceRepo = new DeviceRepository(db);

    // Create a test device
    const secret = generateSecret();
    deviceRepo.add('test-device', secret.toString('base64'), 'Test device', 1000000);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('accept', () => {
    it('should accept a new event', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', {
        body: 'Test message',
        originatingAddress: '+1234567890',
      });

      const inserted = eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, 1000000);
      expect(inserted).toBe(true);
    });

    it('should return false for idempotent duplicate', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', {
        body: 'Test message',
      });

      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, 1000000);
      const duplicate = eventRepo.accept('test-device', 'key-1', 'nonce-2', envelope, 1000001);
      expect(duplicate).toBe(false);
    });

    it('should throw on replayed nonce with different idempotency key', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope1 = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'Msg 1' }, { deliveryId: 'd1', sourceEventId: 's1' });
      const envelope2 = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'Msg 2' }, { deliveryId: 'd2', sourceEventId: 's2' });

      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope1, 1000000);
      expect(() => eventRepo.accept('test-device', 'key-2', 'nonce-1', envelope2, 1000001)).toThrow('replayed nonce');
    });
  });

  describe('getMessages', () => {
    it('should return incoming SMS messages', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;

      // Insert multiple events
      for (let i = 0; i < 3; i++) {
        const envelope = createEncryptedEnvelope(
          secret,
          'test-device',
          'INCOMING_SMS',
          {
            body: `Message ${i}`,
            originatingAddress: `+123456789${i}`,
            partCount: 1,
          },
          { deliveryId: `d${i}`, sourceEventId: `s${i}`, createdAt: 1000000 + i },
        );
        eventRepo.accept('test-device', `key-${i}`, `nonce-${i}`, envelope, 1000000 + i);
      }

      // Insert a notification (should not appear)
      const notifEnvelope = createEncryptedEnvelope(
        secret,
        'test-device',
        'NOTIFICATION',
        { title: 'Test', body: 'Notification' },
        { deliveryId: 'd-notif', sourceEventId: 's-notif' },
      );
      eventRepo.accept('test-device', 'key-notif', 'nonce-notif', notifEnvelope, 1000100);

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100);

      expect(messages).toHaveLength(3);
      expect(messages[0].body).toBe('Message 2'); // Most recent first
      expect(messages[0].sender).toBe('+1234567892');
    });

    it('should filter by deviceId', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;

      // Create another device
      const secret2 = generateSecret();
      deviceRepo.add('device-2', secret2.toString('base64'), 'Device 2', 1000000);

      // Insert events for both devices
      for (const deviceId of ['test-device', 'device-2']) {
        const s = deviceId === 'test-device' ? secret : secret2;
        const envelope = createEncryptedEnvelope(s, deviceId, 'INCOMING_SMS', { body: `Msg from ${deviceId}` }, { deliveryId: `d-${deviceId}`, sourceEventId: `s-${deviceId}` });
        eventRepo.accept(deviceId, `key-${deviceId}`, `nonce-${deviceId}`, envelope, 1000000);
      }

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100, { deviceId: 'test-device' });

      expect(messages).toHaveLength(1);
      expect(messages[0].deviceId).toBe('test-device');
    });

    it('should filter by deviceIds set', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const secret2 = generateSecret();
      deviceRepo.add('device-2', secret2.toString('base64'), 'Device 2', 1000000);
      const secret3 = generateSecret();
      deviceRepo.add('device-3', secret3.toString('base64'), 'Device 3', 1000000);

      for (const deviceId of ['test-device', 'device-2', 'device-3']) {
        const s = deviceRepo.loadSecrets().get(deviceId)!;
        const envelope = createEncryptedEnvelope(s, deviceId, 'INCOMING_SMS', { body: `Msg from ${deviceId}` }, { deliveryId: `d-${deviceId}`, sourceEventId: `s-${deviceId}` });
        eventRepo.accept(deviceId, `key-${deviceId}`, `nonce-${deviceId}`, envelope, 1000000);
      }

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100, { deviceIds: new Set(['test-device', 'device-3']) });

      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.deviceId === 'test-device' || m.deviceId === 'device-3')).toBe(true);
    });

    it('should filter by slotIndex', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;

      const env0 = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'SIM 0' }, { deliveryId: 'd0', sourceEventId: 's0', slotIndex: 0 });
      const env1 = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'SIM 1' }, { deliveryId: 'd1', sourceEventId: 's1', slotIndex: 1 });

      eventRepo.accept('test-device', 'key-0', 'nonce-0', env0, 1000000);
      eventRepo.accept('test-device', 'key-1', 'nonce-1', env1, 1000001);

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100, { slotIndex: 0 });

      expect(messages).toHaveLength(1);
      expect(messages[0].slotIndex).toBe(0);
    });

    it('should respect pagination with limit', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;

      for (let i = 0; i < 5; i++) {
        const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: `Msg ${i}` }, { deliveryId: `d${i}`, sourceEventId: `s${i}`, createdAt: 1000000 + i });
        eventRepo.accept('test-device', `key-${i}`, `nonce-${i}`, envelope, 1000000 + i);
      }

      const secrets = deviceRepo.loadSecrets();
      // Page 1: most recent 2 events
      const page1 = eventRepo.getMessages(secrets, 2);
      expect(page1).toHaveLength(2);

      // Page 2: next 2 events (older than page1's last item)
      const page2 = eventRepo.getMessages(secrets, 2, { beforeId: page1[1].id });
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBeLessThan(page1[1].id);
    });

    it('should extract OTP candidates', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', {
        body: 'Your verification code is 123456',
        originatingAddress: '+1234567890',
      }, { deliveryId: 'd1', sourceEventId: 's1' });

      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, 1000000);

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100);

      expect(messages[0].otpCandidates).toContain('123456');
    });
  });

  describe('getNotifications', () => {
    it('should return notifications', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'NOTIFICATION', {
        eventType: 'POSTED',
        sourcePackage: 'com.example.app',
        title: 'Test Title',
        body: 'Test Body',
        notificationId: 12345,
        postedAt: 1000000,
        observedAt: 1000001,
        channelId: 'default',
        category: 'msg',
      }, { deliveryId: 'd1', sourceEventId: 's1' });

      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, 1000000);

      const secrets = deviceRepo.loadSecrets();
      const notifications = eventRepo.getNotifications(secrets, 100);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].title).toBe('Test Title');
      expect(notifications[0].body).toBe('Test Body');
      expect(notifications[0].sourcePackage).toBe('com.example.app');
      expect(notifications[0].notificationId).toBe(12345);
    });
  });

  describe('prune', () => {
    it('should prune old events', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const now = Date.now();

      // Insert old event (2 days ago)
      const oldTime = now - 2 * 86400000;
      const oldEnvelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'Old' }, { deliveryId: 'd-old', sourceEventId: 's-old', createdAt: oldTime });
      eventRepo.accept('test-device', 'key-old', 'nonce-old', oldEnvelope, oldTime);

      // Insert new event (now)
      const newEnvelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'New' }, { deliveryId: 'd-new', sourceEventId: 's-new', createdAt: now });
      eventRepo.accept('test-device', 'key-new', 'nonce-new', newEnvelope, now);

      // Prune events older than 1 day
      const pruned = eventRepo.prune(1, now);
      expect(pruned).toBe(1);

      const secrets = deviceRepo.loadSecrets();
      const messages = eventRepo.getMessages(secrets, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe('New');
    });

    it('should not prune when retention days is 0', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const now = Date.now();
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'Test' }, { deliveryId: 'd1', sourceEventId: 's1', createdAt: now });
      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, now);

      expect(eventRepo.prune(0, now)).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all events and related data', () => {
      const secret = deviceRepo.loadSecrets().get('test-device')!;
      const envelope = createEncryptedEnvelope(secret, 'test-device', 'INCOMING_SMS', { body: 'Test' }, { deliveryId: 'd1', sourceEventId: 's1' });
      eventRepo.accept('test-device', 'key-1', 'nonce-1', envelope, 1000000);

      eventRepo.clear();

      const events = db.prepare('SELECT * FROM events').all();
      expect(events).toHaveLength(0);

      const nonces = db.prepare('SELECT * FROM request_nonces').all();
      expect(nonces).toHaveLength(0);
    });
  });
});
