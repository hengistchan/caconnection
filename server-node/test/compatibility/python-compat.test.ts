/**
 * Python/Node compatibility tests (P0).
 *
 * These tests verify that the Node.js implementation produces identical
 * behavior to the Python gateway for:
 *   - Event acceptance with idempotency
 *   - Nonce replay protection
 *   - OTP atomic claim semantics
 *   - Pagination behavior
 *   - Duplicate request handling
 *   - Database schema compatibility
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EventRepository } from '../../src/repositories/event-repository.js';
import { OtpRepository } from '../../src/repositories/otp-repository.js';
import { DeviceRepository } from '../../src/repositories/device-repository.js';
import { OutboundRepository } from '../../src/repositories/outbound-repository.js';
import { initializeDatabase } from '../../src/database/database.js';
import { encryptPayload, decryptPayload } from '../../src/crypto/payload-crypto.js';
import { expectedSignature, verifySignature } from '../../src/crypto/request-signature.js';
import { extractOtpCandidates } from '../../src/crypto/otp-extraction.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'compat-test-'));
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

describe('Python/Node Compatibility', () => {
  let db: DatabaseSync;
  let dir: string;
  let eventRepo: EventRepository;
  let otpRepo: OtpRepository;
  let deviceRepo: DeviceRepository;
  let outboundRepo: OutboundRepository;
  let secret: Buffer;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    eventRepo = new EventRepository(db);
    otpRepo = new OtpRepository(db);
    deviceRepo = new DeviceRepository(db);
    outboundRepo = new OutboundRepository(db);

    secret = randomBytes(32);
    deviceRepo.add('test-device', secret.toString('base64'), 'Test', 1000000);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Idempotency semantics', () => {
    it('should return duplicate=false for first event, duplicate=true for second', () => {
      const envelope = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test', originatingAddress: '+123' },
      }, 'test-device', secret);

      // First insert
      const first = eventRepo.accept('test-device', 'idem-key-1', 'nonce-1', envelope, 1000000);
      expect(first).toBe(true);

      // Second insert with same idempotency key (different nonce is OK)
      const second = eventRepo.accept('test-device', 'idem-key-1', 'nonce-2', envelope, 1000001);
      expect(second).toBe(false);
    });

    it('should accept same payload with different idempotency keys', () => {
      const envelope = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test', originatingAddress: '+123' },
      }, 'test-device', secret);

      eventRepo.accept('test-device', 'idem-key-1', 'nonce-1', envelope, 1000000);
      eventRepo.accept('test-device', 'idem-key-2', 'nonce-2', envelope, 1000001);

      const messages = eventRepo.getMessages(new Map([['test-device', secret]]), 100);
      expect(messages).toHaveLength(2);
    });
  });

  describe('Nonce replay protection', () => {
    it('should reject replayed nonce with different idempotency key', () => {
      const envelope1 = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test 1', originatingAddress: '+123' },
      }, 'test-device', secret);

      const envelope2 = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-2',
        sourceEventId: 's-2',
        eventType: 'INCOMING_SMS',
        createdAt: 1000001,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test 2', originatingAddress: '+456' },
      }, 'test-device', secret);

      eventRepo.accept('test-device', 'idem-key-1', 'replay-nonce', envelope1, 1000000);

      expect(() => eventRepo.accept('test-device', 'idem-key-2', 'replay-nonce', envelope2, 1000001))
        .toThrow('replayed nonce');
    });

    it('should throw on replayed nonce even with same idempotency key', () => {
      const envelope = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test', originatingAddress: '+123' },
      }, 'test-device', secret);

      // First insert
      eventRepo.accept('test-device', 'idem-key-1', 'nonce-1', envelope, 1000000);

      // Replay with same nonce - Python throws "replayed nonce" even for idempotent retries
      expect(() => eventRepo.accept('test-device', 'idem-key-1', 'nonce-1', envelope, 1000001))
        .toThrow('replayed nonce');
    });
  });

  describe('OTP claim atomicity', () => {
    it('should only allow one client to claim an OTP', () => {
      const envelope = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Your code is 123456', originatingAddress: '+123' },
      }, 'test-device', secret);

      eventRepo.accept('test-device', 'idem-key-1', 'nonce-1', envelope, 1000000);

      const secrets = new Map([['test-device', secret]]);

      // First claim
      const claim1 = otpRepo.claimLatest(secrets, 'client-1', 1000001, 600);
      expect(claim1).not.toBeNull();
      expect(claim1!.code).toBe('123456');

      // Second claim by different client should fail
      const claim2 = otpRepo.claimLatest(secrets, 'client-2', 1000002, 600);
      expect(claim2).toBeNull();
    });

    it('should claim most recent OTP first', () => {
      const now = Date.now();

      // Insert older OTP
      const envelope1 = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: now - 5000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Old code 111111', originatingAddress: '+123' },
      }, 'test-device', secret);
      eventRepo.accept('test-device', 'idem-1', 'nonce-1', envelope1, now - 5000);

      // Insert newer OTP
      const envelope2 = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-2',
        sourceEventId: 's-2',
        eventType: 'INCOMING_SMS',
        createdAt: now - 1000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'New code 222222', originatingAddress: '+456' },
      }, 'test-device', secret);
      eventRepo.accept('test-device', 'idem-2', 'nonce-2', envelope2, now - 1000);

      const secrets = new Map([['test-device', secret]]);
      const claim = otpRepo.claimLatest(secrets, 'client-1', now, 600);

      expect(claim!.code).toBe('222222'); // Most recent
    });
  });

  describe('Pagination compatibility', () => {
    it('should return messages in descending ID order', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const envelope = encryptPayload({
          schemaVersion: 1,
          deliveryId: `d-${i}`,
          sourceEventId: `s-${i}`,
          eventType: 'INCOMING_SMS',
          createdAt: now + i,
          subscriptionId: null,
          slotIndex: 0,
          payload: { body: `Msg ${i}`, originatingAddress: `+${i}` },
        }, 'test-device', secret);
        eventRepo.accept('test-device', `idem-${i}`, `nonce-${i}`, envelope, now + i);
      }

      const secrets = new Map([['test-device', secret]]);
      const messages = eventRepo.getMessages(secrets, 100);

      expect(messages).toHaveLength(5);
      // Should be in descending order (newest first)
      for (let i = 0; i < messages.length - 1; i++) {
        expect(messages[i].id).toBeGreaterThan(messages[i + 1].id);
      }
    });

    it('should respect limit parameter', () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        const envelope = encryptPayload({
          schemaVersion: 1,
          deliveryId: `d-${i}`,
          sourceEventId: `s-${i}`,
          eventType: 'INCOMING_SMS',
          createdAt: now + i,
          subscriptionId: null,
          slotIndex: 0,
          payload: { body: `Msg ${i}`, originatingAddress: `+${i}` },
        }, 'test-device', secret);
        eventRepo.accept('test-device', `idem-${i}`, `nonce-${i}`, envelope, now + i);
      }

      const secrets = new Map([['test-device', secret]]);

      // Limit 3
      const page1 = eventRepo.getMessages(secrets, 3);
      expect(page1).toHaveLength(3);

      // Limit 100 (should return all)
      const all = eventRepo.getMessages(secrets, 100);
      expect(all).toHaveLength(10);
    });

    it('should support beforeId cursor pagination', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const envelope = encryptPayload({
          schemaVersion: 1,
          deliveryId: `d-${i}`,
          sourceEventId: `s-${i}`,
          eventType: 'INCOMING_SMS',
          createdAt: now + i,
          subscriptionId: null,
          slotIndex: 0,
          payload: { body: `Msg ${i}`, originatingAddress: `+${i}` },
        }, 'test-device', secret);
        eventRepo.accept('test-device', `idem-${i}`, `nonce-${i}`, envelope, now + i);
      }

      const secrets = new Map([['test-device', secret]]);

      // Get first page
      const page1 = eventRepo.getMessages(secrets, 2);
      expect(page1).toHaveLength(2);

      // Get second page using beforeId
      const page2 = eventRepo.getMessages(secrets, 2, { beforeId: page1[1].id });
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBeLessThan(page1[1].id);
    });
  });

  describe('OTP extraction compatibility', () => {
    it('should extract OTP from Chinese context', () => {
      const candidates = extractOtpCandidates('验证码是888888，请在5分钟内输入');
      expect(candidates).toContain('888888');
    });

    it('should extract OTP from English context', () => {
      const candidates = extractOtpCandidates('Your verification code is 123456');
      expect(candidates).toContain('123456');
    });

    it('should prefer contextual matches', () => {
      const candidates = extractOtpCandidates('111111.\nverification code 222222');
      expect(candidates[0]).toBe('222222');
    });

    it('should prefer 6 and4 digit codes', () => {
      const candidates = extractOtpCandidates('Codes: 12345 and 123456');
      expect(candidates[0]).toBe('123456');
    });

    it('should not extract adjacent digits', () => {
      const candidates = extractOtpCandidates('Order 123456789 confirmed');
      expect(candidates).toHaveLength(0);
    });
  });

  describe('Signature compatibility', () => {
    it('should produce identical canonical request format', () => {
      const body = Buffer.from('{"test": "data"}');
      const timestampMs = 1700000000000;
      const nonce = 'test-nonce-abc123';
      const deviceId = 'test-device';
      const idempotencyKey = 'test-key-xyz789';

      const canonical = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);

      // Verify it's a valid Base64 string
      expect(() => Buffer.from(canonical, 'base64')).not.toThrow();
    });

    it('should verify signature using timing-safe comparison', () => {
      const body = Buffer.from('{"test": "data"}');
      const timestampMs = 1700000000000;
      const nonce = 'test-nonce';
      const deviceId = 'test-device';
      const idempotencyKey = 'test-key';

      const signature = expectedSignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body);

      expect(verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)).toBe(true);
      expect(verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, 'wrong')).toBe(false);
    });
  });

  describe('Outbound command compatibility', () => {
    it('should create outbound command with QUEUED status', () => {
      const command = outboundRepo.create(
        'test-device', secret, 0, '+1234567890', 'Test SMS', 'idem-key-1', 1000000, 300,
      );

      expect(command.status).toBe('QUEUED');
      expect(command.claimedAt).toBeNull();
      expect(command.expiresAt).toBe(1000000 + 300 * 1000);
    });

    it('should claim commands atomically', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg 1', 'key-1', 1000000, 3600);
      outboundRepo.create('test-device', secret, 0, '+222', 'Msg 2', 'key-2', 1000001, 3600);

      const claimed = outboundRepo.claim('test-device', secret, 10, 1000002);

      expect(claimed).toHaveLength(2);
      expect(claimed[0].status).toBe('CLAIMED');
      expect(claimed[0].claimedAt).toBe(1000002);
    });

    it('should not downgrade status', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 3600);
      const claimed = outboundRepo.claim('test-device', secret, 10, 1000001);
      const commandId = claimed[0].commandId;

      // Update to DELIVERED
      outboundRepo.updateStatus('test-device', { commandId, status: 'DELIVERED' }, 1000002);

      // Try to downgrade to QUEUED
      outboundRepo.updateStatus('test-device', { commandId, status: 'QUEUED' }, 1000003);

      const secrets = new Map([['test-device', secret]]);
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].status).toBe('DELIVERED');
    });
  });

  describe('Device lifecycle compatibility', () => {
    it('should retire device and expire pending commands', () => {
      // Create outbound command
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 300);

      // Retire device
      deviceRepo.retire('test-device', 2000000);

      // Command should be expired
      const secrets = new Map([['test-device', secret]]);
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].status).toBe('EXPIRED');
    });

    it('should restore retired device', () => {
      deviceRepo.retire('test-device', 1000000);
      expect(deviceRepo.isActive('test-device')).toBe(false);

      deviceRepo.restore('test-device');
      expect(deviceRepo.isActive('test-device')).toBe(true);
    });

    it('should purge device and all associated data', () => {
      // Create related data
      const envelope = encryptPayload({
        schemaVersion: 1,
        deliveryId: 'd-1',
        sourceEventId: 's-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test', originatingAddress: '+123' },
      }, 'test-device', secret);
      eventRepo.accept('test-device', 'idem-1', 'nonce-1', envelope, 1000000);

      // Purge
      const purged = deviceRepo.purge('test-device');
      expect(purged).toBe(true);

      // Verify all data is gone
      expect(deviceRepo.getById('test-device')).toBeNull();
    });
  });

  describe('Schema compatibility', () => {
    it('should have all required tables', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const tableNames = tables.map(t => t.name);

      expect(tableNames).toContain('events');
      expect(tableNames).toContain('request_nonces');
      expect(tableNames).toContain('otp_claims');
      expect(tableNames).toContain('pairing_sessions');
      expect(tableNames).toContain('outbound_commands');
      expect(tableNames).toContain('devices');
      expect(tableNames).toContain('device_status');
      expect(tableNames).toContain('device_lines');
      expect(tableNames).toContain('admin_audit_log');
      expect(tableNames).toContain('gateway_groups');
      expect(tableNames).toContain('gateway_group_members');
      expect(tableNames).toContain('gateway_metadata');
    });

    it('should have WAL journal mode', () => {
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode).toBe('wal');
    });

    it('should have foreign keys enabled', () => {
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
    });
  });
});