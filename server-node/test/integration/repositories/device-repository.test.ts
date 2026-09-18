/**
 * Integration tests for DeviceRepository.
 *
 * Tests device CRUD, secret rotation, lifecycle operations, and data integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { encryptPayload, decryptPayload } from '../../../src/crypto/payload-crypto.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'device-repo-test-'));
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

function generateSecretBase64(): string {
  return randomBytes(32).toString('base64');
}

describe('DeviceRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let repo: DeviceRepository;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    repo = new DeviceRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('should create a new device', () => {
      const secret = generateSecretBase64();
      const device = repo.add('test-device', secret, 'Test device', 1000000);

      expect(device.deviceId).toBe('test-device');
      expect(device.description).toBe('Test device');
      expect(device.createdAt).toBe(1000000);
      expect(device.lastSeenAt).toBeNull();
      expect(device.retiredAt).toBeNull();
      expect(device.health).toBe('NEVER');
    });

    it('should reject duplicate device ID', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'First', 1000000);

      expect(() => repo.add('test-device', secret, 'Second', 2000000)).toThrow('already exists');
    });

    it('should reject invalid device ID format', () => {
      const secret = generateSecretBase64();
      expect(() => repo.add('invalid id!', secret, 'Test', 1000000)).toThrow('Invalid device ID');
    });

    it('should reject short secrets', () => {
      const shortSecret = randomBytes(16).toString('base64');
      expect(() => repo.add('test-device', shortSecret, 'Test', 1000000)).toThrow('at least 32 bytes');
    });
  });

  describe('isActive', () => {
    it('should return true for existing active device', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);
      expect(repo.isActive('test-device')).toBe(true);
    });

    it('should return true for non-existent device (legacy behavior)', () => {
      expect(repo.isActive('non-existent')).toBe(true);
    });

    it('should return false for retired device', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);
      repo.retire('test-device', 2000000);
      expect(repo.isActive('test-device')).toBe(false);
    });
  });

  describe('retire / restore', () => {
    it('should retire a device', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);

      const retired = repo.retire('test-device', 2000000);
      expect(retired).toBe(true);

      const device = repo.getById('test-device');
      expect(device!.retiredAt).toBe(2000000);
      expect(device!.health).toBe('RETIRED');
    });

    it('should return false when retiring non-existent device', () => {
      expect(repo.retire('non-existent', 2000000)).toBe(false);
    });

    it('should restore a retired device', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);
      repo.retire('test-device', 2000000);

      const restored = repo.restore('test-device');
      expect(restored).toBe(true);

      const device = repo.getById('test-device');
      expect(device!.retiredAt).toBeNull();
    });

    it('should return false when restoring non-existent device', () => {
      expect(repo.restore('non-existent')).toBe(false);
    });
  });

  describe('purge', () => {
    it('should purge a device and all associated data', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);

      // Insert related data
      db.prepare("INSERT INTO device_status(device_id, observed_at, updated_at) VALUES (?, ?, ?)").run('test-device', 1000000, 1000000);
      db.prepare("INSERT INTO device_lines(device_id, slot_index, is_active, observed_at) VALUES (?, ?, ?, ?)").run('test-device', 0, 1, 1000000);
      db.prepare("INSERT INTO request_nonces(device_id, nonce, seen_at) VALUES (?, ?, ?)").run('test-device', 'nonce1', 1000000);

      const purged = repo.purge('test-device');
      expect(purged).toBe(true);

      // Verify device is gone
      expect(repo.getById('test-device')).toBeNull();

      // Verify related data is gone
      const status = db.prepare('SELECT * FROM device_status WHERE device_id = ?').get('test-device');
      expect(status).toBeUndefined();

      const lines = db.prepare('SELECT * FROM device_lines WHERE device_id = ?').all('test-device');
      expect(lines).toHaveLength(0);

      const nonces = db.prepare('SELECT * FROM request_nonces WHERE device_id = ?').all('test-device');
      expect(nonces).toHaveLength(0);
    });

    it('should return false when purging non-existent device', () => {
      expect(repo.purge('non-existent')).toBe(false);
    });
  });

  describe('update - secret rotation', () => {
    it('should update description only', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Original', 1000000);

      const updated = repo.update('test-device', 'Updated');
      expect(updated!.description).toBe('Updated');
    });

    it('should update secret and re-encrypt events', () => {
      const oldSecret = generateSecretBase64();
      const newSecret = generateSecretBase64();
      repo.add('test-device', oldSecret, 'Test', 1000000);

      // Insert an event with old secret
      const envelope = {
        schemaVersion: 1,
        deliveryId: 'delivery-1',
        sourceEventId: 'source-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { body: 'Test message', originatingAddress: '+1234567890' },
      };

      // Encrypt with old secret
      const encrypted = encryptPayload(envelope, 'test-device', Buffer.from(oldSecret, 'base64'));

      db.prepare(`
        INSERT INTO events(device_id, idempotency_key, delivery_id, source_event_id, event_type, created_at, received_at, subscription_id, slot_index, envelope_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-device', 'key-1', 'delivery-1', 'source-1', 'INCOMING_SMS', 1000000, 1000000, null, 0, JSON.stringify(encrypted));

      // Rotate secret
      repo.update('test-device', undefined, newSecret);

      // Verify event can be decrypted with new secret
      const eventRow = db.prepare('SELECT envelope_json FROM events WHERE device_id = ?').get('test-device') as { envelope_json: string };
      const storedEnvelope = JSON.parse(eventRow.envelope_json);
      const decrypted = decryptPayload(storedEnvelope, 'test-device', Buffer.from(newSecret, 'base64'));

      expect(decrypted.payload).toEqual({ body: 'Test message', originatingAddress: '+1234567890' });
    });

    it('should update secret and re-encrypt outbound commands', () => {
      const oldSecret = generateSecretBase64();
      const newSecret = generateSecretBase64();
      repo.add('test-device', oldSecret, 'Test', 1000000);

      // Insert an outbound command with old secret
      const envelope = {
        schemaVersion: 1,
        deliveryId: 'cmd-1',
        sourceEventId: 'cmd-1',
        eventType: 'OUTBOUND_SMS_COMMAND',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { recipient: '+1234567890', body: 'Test SMS' },
      };

      const encrypted = encryptPayload(envelope, 'test-device', Buffer.from(oldSecret, 'base64'));

      db.prepare(`
        INSERT INTO outbound_commands(command_id, idempotency_key, device_id, slot_index, envelope_json, status, created_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('cmd-1', 'idem-1', 'test-device', 0, JSON.stringify(encrypted), 'QUEUED', 1000000, 2000000, 1000000);

      // Rotate secret
      repo.update('test-device', undefined, newSecret);

      // Verify command can be decrypted with new secret
      const cmdRow = db.prepare('SELECT envelope_json FROM outbound_commands WHERE command_id = ?').get('cmd-1') as { envelope_json: string };
      const storedEnvelope = JSON.parse(cmdRow.envelope_json);
      const decrypted = decryptPayload(storedEnvelope, 'test-device', Buffer.from(newSecret, 'base64'));

      expect(decrypted.payload).toEqual({ recipient: '+1234567890', body: 'Test SMS' });
    });

    it('should not re-encrypt when secret is the same', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);

      // Insert an event
      const envelope = {
        schemaVersion: 2,
        deliveryId: 'delivery-1',
        sourceEventId: 'source-1',
        eventType: 'INCOMING_SMS',
        createdAt: 1000000,
        subscriptionId: null,
        slotIndex: 0,
        payload: { algorithm: 'AES-256-GCM', nonceBase64: 'test', ciphertextBase64: 'test' },
      };

      db.prepare(`
        INSERT INTO events(device_id, idempotency_key, delivery_id, source_event_id, event_type, created_at, received_at, subscription_id, slot_index, envelope_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-device', 'key-1', 'delivery-1', 'source-1', 'INCOMING_SMS', 1000000, 1000000, null, 0, JSON.stringify(envelope));

      // Update with same secret - should not re-encrypt
      repo.update('test-device', undefined, secret);

      // Verify envelope is unchanged
      const eventRow = db.prepare('SELECT envelope_json FROM events WHERE device_id = ?').get('test-device') as { envelope_json: string };
      expect(JSON.parse(eventRow.envelope_json)).toEqual(envelope);
    });

    it('should return null for non-existent device', () => {
      const result = repo.update('non-existent', 'New description');
      expect(result).toBeNull();
    });
  });

  describe('loadSecrets', () => {
    it('should load all device secrets', () => {
      const secret1 = generateSecretBase64();
      const secret2 = generateSecretBase64();
      repo.add('device-1', secret1, 'Device 1', 1000000);
      repo.add('device-2', secret2, 'Device 2', 1000000);

      const secrets = repo.loadSecrets();
      expect(secrets.size).toBe(2);
      expect(secrets.has('device-1')).toBe(true);
      expect(secrets.has('device-2')).toBe(true);
    });

    it('should skip devices with invalid secrets', () => {
      const validSecret = generateSecretBase64();
      repo.add('valid-device', validSecret, 'Valid', 1000000);

      // Manually insert a device with short secret
      db.prepare("INSERT INTO devices(device_id, secret_base64, description, created_at) VALUES (?, ?, ?, ?)").run(
        'invalid-device',
        randomBytes(16).toString('base64'),
        'Invalid',
        1000000,
      );

      const secrets = repo.loadSecrets();
      expect(secrets.size).toBe(1);
      expect(secrets.has('valid-device')).toBe(true);
      expect(secrets.has('invalid-device')).toBe(false);
    });
  });

  describe('recordNonce / touchDevice', () => {
    it('should record a nonce', () => {
      repo.add('test-device', generateSecretBase64(), 'Test', 1000000);
      repo.recordNonce('test-device', 'nonce-1', 1000000);

      const nonce = db.prepare('SELECT * FROM request_nonces WHERE device_id = ? AND nonce = ?').get('test-device', 'nonce-1');
      expect(nonce).toBeDefined();
    });

    it('should throw on replayed nonce', () => {
      repo.add('test-device', generateSecretBase64(), 'Test', 1000000);
      repo.recordNonce('test-device', 'nonce-1', 1000000);

      expect(() => repo.recordNonce('test-device', 'nonce-1', 1000001)).toThrow('replayed nonce');
    });

    it('should touch device last_seen_at', () => {
      repo.add('test-device', generateSecretBase64(), 'Test', 1000000);
      repo.touchDevice('test-device', 2000000);

      const device = repo.getById('test-device');
      expect(device!.lastSeenAt).toBe(2000000);
    });
  });

  describe('getById', () => {
    it('should return null for non-existent device', () => {
      expect(repo.getById('non-existent')).toBeNull();
    });

    it('should return device with status and lines', () => {
      const secret = generateSecretBase64();
      repo.add('test-device', secret, 'Test', 1000000);

      // Add status
      db.prepare(`
        INSERT INTO device_status(device_id, observed_at, app_version, version_code, target_sdk, android_version, manufacturer, model, receive_mode, default_sms_role, receive_sms_granted, send_sms_granted, read_phone_state_granted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test-device', 1500000, '1.0.0', 100, 33, 'Android 13', 'Google', 'Pixel 7', 'DEFAULT_SMS', 1, 1, 1, 1, 1500000);

      // Add lines
      db.prepare('INSERT INTO device_lines(device_id, slot_index, subscription_id, carrier_name, display_name, is_active, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'test-device', 0, 1, 'Carrier A', 'Line 1', 1, 1500000,
      );

      const device = repo.getById('test-device');
      expect(device).not.toBeNull();
      expect(device!.status.appVersion).toBe('1.0.0');
      expect(device!.status.lines).toHaveLength(1);
      expect(device!.status.lines[0].slotIndex).toBe(0);
      expect(device!.status.lines[0].carrierName).toBe('Carrier A');
    });
  });
});
