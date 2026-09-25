/**
 * Integration tests for OutboundRepository.
 *
 * Tests outbound command creation, claiming, status updates, and expiration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { OutboundRepository } from '../../../src/repositories/outbound-repository.js';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import {
  OUTBOUND_COMMAND_LEASE_MS,
  OUTBOUND_DISPATCH_SETTLE_MS,
  OUTBOUND_SENT_SETTLE_MS,
} from '../../../src/config/constants.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-repo-test-'));
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

describe('OutboundRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let outboundRepo: OutboundRepository;
  let deviceRepo: DeviceRepository;
  let secret: Buffer;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    outboundRepo = new OutboundRepository(db);
    deviceRepo = new DeviceRepository(db);

    secret = generateSecret();
    deviceRepo.add('test-device', secret.toString('base64'), 'Test device', 1000000);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a new outbound command', () => {
      const command = outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Test message',
        'idempotency-key-1',
        1000000,
        300,
      );

      expect(command.commandId).toBeDefined();
      expect(command.deviceId).toBe('test-device');
      expect(command.slotIndex).toBe(0);
      expect(command.recipient).toBe('+1234567890');
      expect(command.body).toBe('Test message');
      expect(command.status).toBe('QUEUED');
      expect(command.createdAt).toBe(1000000);
      expect(command.expiresAt).toBe(1000000 + 300 * 1000);
      expect(command.claimedAt).toBeNull();
    });

    it('should return existing command for same idempotency key', () => {
      const command1 = outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Test message',
        'idempotency-key-1',
        1000000,
        300,
      );

      const command2 = outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Test message',
        'idempotency-key-1',
        1000001,
        300,
      );

      expect(command2.commandId).toBe(command1.commandId);
    });

    it('should throw on idempotency key conflict', () => {
      outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Message 1',
        'idempotency-key-1',
        1000000,
        300,
      );

      expect(() => outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Message 2', // Different body
        'idempotency-key-1',
        1000001,
        300,
      )).toThrow('idempotency key conflict');
    });

    it('should allow one logical key to fan out to several devices', () => {
      const first = outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Fan-out message',
        'shared-logical-key',
        1000000,
        300,
      );
      const second = outboundRepo.create(
        'other-device',
        secret,
        0,
        '+1234567890',
        'Fan-out message',
        'shared-logical-key',
        1000001,
        300,
      );

      expect(second.commandId).not.toBe(first.commandId);
    });

    it('should encrypt the payload', () => {
      const command = outboundRepo.create(
        'test-device',
        secret,
        0,
        '+1234567890',
        'Test message',
        'idempotency-key-1',
        1000000,
        300,
      );

      // Verify the command can be decrypted
      const row = db.prepare('SELECT envelope_json FROM outbound_commands WHERE command_id = ?').get(command.commandId) as { envelope_json: string };
      const envelope = JSON.parse(row.envelope_json);

      // Should be encrypted (schemaVersion 2)
      expect(envelope.schemaVersion).toBe(2);
      expect(envelope.payload.algorithm).toBe('AES-256-GCM');
    });
  });

  describe('list', () => {
    it('should list outbound commands', () => {
      for (let i = 0; i < 3; i++) {
        outboundRepo.create(
          'test-device',
          secret,
          0,
          '+1234567890',
          `Message ${i}`,
          `idempotency-key-${i}`,
          1000000 + i,
          300,
        );
      }

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100);

      expect(commands).toHaveLength(3);
      // Should be ordered by id DESC
      expect(commands[0].body).toBe('Message 2');
    });

    it('should filter by deviceId', () => {
      const secret2 = generateSecret();
      deviceRepo.add('device-2', secret2.toString('base64'), 'Device 2', 1000000);

      outboundRepo.create('test-device', secret, 0, '+111', 'Msg 1', 'key-1', 1000000, 300);
      outboundRepo.create('device-2', secret2, 0, '+222', 'Msg 2', 'key-2', 1000000, 300);

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100, { deviceId: 'test-device' });

      expect(commands).toHaveLength(1);
      expect(commands[0].deviceId).toBe('test-device');
    });

    it('should filter by deviceIds set', () => {
      const secret2 = generateSecret();
      deviceRepo.add('device-2', secret2.toString('base64'), 'Device 2', 1000000);
      const secret3 = generateSecret();
      deviceRepo.add('device-3', secret3.toString('base64'), 'Device 3', 1000000);

      outboundRepo.create('test-device', secret, 0, '+111', 'Msg 1', 'key-1', 1000000, 300);
      outboundRepo.create('device-2', secret2, 0, '+222', 'Msg 2', 'key-2', 1000000, 300);
      outboundRepo.create('device-3', secret3, 0, '+333', 'Msg 3', 'key-3', 1000000, 300);

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100, { deviceIds: new Set(['test-device', 'device-3']) });

      expect(commands).toHaveLength(2);
    });

    it('should respect pagination', () => {
      for (let i = 0; i < 5; i++) {
        outboundRepo.create('test-device', secret, 0, '+111', `Msg ${i}`, `key-${i}`, 1000000 + i, 300);
      }

      const secrets = deviceRepo.loadSecrets();
      const page1 = outboundRepo.list(secrets, 2);
      expect(page1).toHaveLength(2);

      const page2 = outboundRepo.list(secrets, 2, { beforeId: page1[1].id });
      expect(page2).toHaveLength(2);
    });

    it('should mark expired commands as EXPIRED', () => {
      // Create an expired command
      outboundRepo.create('test-device', secret, 0, '+111', 'Expired', 'key-1', 1000000, 1); // 1 second expiry

      const secrets = deviceRepo.loadSecrets();

      // List after expiry
      const commands = outboundRepo.list(secrets, 100);
      expect(commands).toHaveLength(1);
      expect(commands[0].status).toBe('EXPIRED');
    });

    it('should return empty for empty deviceIds set', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 300);

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100, { deviceIds: new Set() });

      expect(commands).toHaveLength(0);
    });
  });

  describe('claim', () => {
    it('should claim queued commands', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg 1', 'key-1', 1000000, 300);
      outboundRepo.create('test-device', secret, 0, '+222', 'Msg 2', 'key-2', 1000001, 300);

      const claimed = outboundRepo.claim('test-device', secret, 10, 1000002);

      expect(claimed).toHaveLength(2);
      expect(claimed[0].status).toBe('CLAIMED');
      expect(claimed[0].claimedAt).toBe(1000002);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        outboundRepo.create('test-device', secret, 0, `+${i}`, `Msg ${i}`, `key-${i}`, 1000000 + i, 300);
      }

      const claimed = outboundRepo.claim('test-device', secret, 2, 1000010);

      expect(claimed).toHaveLength(2);
    });

    it('should not claim expired commands', () => {
      const expiresInSeconds = 1;
      outboundRepo.create('test-device', secret, 0, '+111', 'Expired', 'key-1', 1000000, expiresInSeconds);

      // expires_at = 1000000 + 1000 = 1001000
      const claimed = outboundRepo.claim('test-device', secret, 10, 1001001); // After expiry

      expect(claimed).toHaveLength(0);
    });

    it('should reclaim stale claims', () => {
      // Use long expiry so command doesn't expire before lease
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 3600);

      // First claim
      outboundRepo.claim('test-device', secret, 10, 1000001);

      // Claim again after the lease window closes (lease must stay well
      // below the expiry or this recovery path is dead)
      const reclaimed = outboundRepo.claim('test-device', secret, 10, 1000001 + OUTBOUND_COMMAND_LEASE_MS + 1);

      expect(reclaimed).toHaveLength(1);
    });

    it('should return empty when no commands available', () => {
      const claimed = outboundRepo.claim('test-device', secret, 10, 1000000);

      expect(claimed).toHaveLength(0);
    });
  });

  describe('updateStatus', () => {
    it('should update command status', () => {
      // list() sweeps with the real clock (expiry + unconfirmed-send settle),
      // so the fixture must use realistic timestamps.
      const now = Date.now();
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', now, 300);
      const claimed = outboundRepo.claim('test-device', secret, 10, now + 1);
      const commandId = claimed[0].commandId;

      const updated = outboundRepo.updateStatus('test-device', {
        commandId,
        status: 'SENT_TO_MODEM',
        resultCode: 0,
        errorDetail: null,
      }, now + 2);

      expect(updated).toBe(true);

      // Verify update
      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].status).toBe('SENT_TO_MODEM');
    });

    it('should settle unconfirmed sends after the confirmation window', () => {
      const now = Date.now();
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', now, 3600);
      const claimed = outboundRepo.claim('test-device', secret, 10, now + 1);
      const commandId = claimed[0].commandId;

      outboundRepo.updateStatus('test-device', {
        commandId,
        status: 'SENT_TO_MODEM',
        resultCode: 0,
        errorDetail: null,
      }, now + 2);

      // First list: still inside the confirmation window.
      const secrets = deviceRepo.loadSecrets();
      expect(outboundRepo.list(secrets, 100)[0].status).toBe('SENT_TO_MODEM');

      // Simulate the confirmation window elapsing.
      db.prepare('UPDATE outbound_commands SET updated_at = ? WHERE command_id = ?')
        .run(now - OUTBOUND_SENT_SETTLE_MS - 1, commandId);

      const settled = outboundRepo.list(secrets, 100)[0];
      expect(settled.status).toBe('OUTCOME_UNKNOWN');
      expect(settled.errorDetail).toBe('Delivery unconfirmed');
    });

    it('should leave stale CREATED commands recoverable by Android', () => {
      const now = Date.now();
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', now, 3600);
      const claimed = outboundRepo.claim('test-device', secret, 10, now + 1);
      const commandId = claimed[0].commandId;

      outboundRepo.updateStatus('test-device', { commandId, status: 'CREATED' }, now + 2);
      db.prepare('UPDATE outbound_commands SET updated_at = ? WHERE command_id = ?')
        .run(now - OUTBOUND_DISPATCH_SETTLE_MS - 1, commandId);

      const settled = outboundRepo.list(deviceRepo.loadSecrets(), 100)[0];
      expect(settled.status).toBe('CREATED');
    });

    it('should make stale DISPATCHING provisional and accept a late callback', () => {
      const now = Date.now();
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', now, 3600);
      const claimed = outboundRepo.claim('test-device', secret, 10, now + 1);
      const commandId = claimed[0].commandId;

      outboundRepo.updateStatus('test-device', { commandId, status: 'DISPATCHING' }, now + 2);
      db.prepare('UPDATE outbound_commands SET updated_at = ? WHERE command_id = ?')
        .run(now - OUTBOUND_DISPATCH_SETTLE_MS - 1, commandId);

      const unknown = outboundRepo.list(deviceRepo.loadSecrets(), 100)[0];
      expect(unknown.status).toBe('OUTCOME_UNKNOWN');
      expect(unknown.errorDetail).toBe('SMS dispatch outcome unknown');

      outboundRepo.updateStatus('test-device', {
        commandId,
        status: 'CREATED',
      }, now + 3);
      expect(outboundRepo.list(deviceRepo.loadSecrets(), 100)[0].status)
        .toBe('OUTCOME_UNKNOWN');

      outboundRepo.updateStatus('test-device', {
        commandId,
        status: 'SENT_TO_MODEM',
        resultCode: 0,
      }, now + 4);
      expect(outboundRepo.list(deviceRepo.loadSecrets(), 100)[0].status).toBe('SENT_TO_MODEM');
    });

    it('should allow a late delivery callback to correct delivery unknown', () => {
      const now = Date.now();
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', now, 3600);
      const claimed = outboundRepo.claim('test-device', secret, 10, now + 1);
      const commandId = claimed[0].commandId;

      outboundRepo.updateStatus('test-device', { commandId, status: 'SENT_TO_MODEM' }, now + 2);
      db.prepare('UPDATE outbound_commands SET updated_at = ? WHERE command_id = ?')
        .run(now - OUTBOUND_SENT_SETTLE_MS - 1, commandId);
      expect(outboundRepo.list(deviceRepo.loadSecrets(), 100)[0].status)
        .toBe('OUTCOME_UNKNOWN');

      outboundRepo.updateStatus('test-device', { commandId, status: 'DELIVERED' }, now + 3);
      expect(outboundRepo.list(deviceRepo.loadSecrets(), 100)[0].status).toBe('DELIVERED');
    });

    it('should not downgrade status', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 300);
      const claimed = outboundRepo.claim('test-device', secret, 10, 1000001);
      const commandId = claimed[0].commandId;

      // Update to DELIVERED
      outboundRepo.updateStatus('test-device', { commandId, status: 'DELIVERED' }, 1000002);

      // Try to downgrade to CREATED
      outboundRepo.updateStatus('test-device', { commandId, status: 'CREATED' }, 1000003);

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].status).toBe('DELIVERED');
    });

    it('should not update terminal statuses', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 300);
      const claimed = outboundRepo.claim('test-device', secret, 10, 1000001);
      const commandId = claimed[0].commandId;

      // Update to FAILED
      outboundRepo.updateStatus('test-device', { commandId, status: 'FAILED', errorDetail: 'Network error' }, 1000002);

      // Try to update again
      const updated = outboundRepo.updateStatus('test-device', { commandId, status: 'CREATED' }, 1000003);
      expect(updated).toBe(true); // Returns true but doesn't change

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].status).toBe('FAILED');
    });

    it('should return false for unknown command', () => {
      const updated = outboundRepo.updateStatus('test-device', {
        commandId: 'unknown-command-id',
        status: 'SENT_TO_MODEM',
      }, 1000000);

      expect(updated).toBe(false);
    });

    it('should throw for invalid command ID format', () => {
      expect(() => outboundRepo.updateStatus('test-device', {
        commandId: 'invalid!',
        status: 'SENT_TO_MODEM',
      }, 1000000)).toThrow('invalid outbound status');
    });

    it('should truncate long error details', () => {
      outboundRepo.create('test-device', secret, 0, '+111', 'Msg', 'key-1', 1000000, 300);
      const claimed = outboundRepo.claim('test-device', secret, 10, 1000001);
      const commandId = claimed[0].commandId;

      const longError = 'x'.repeat(500);
      outboundRepo.updateStatus('test-device', {
        commandId,
        status: 'FAILED',
        errorDetail: longError,
      }, 1000002);

      const secrets = deviceRepo.loadSecrets();
      const commands = outboundRepo.list(secrets, 100);
      expect(commands[0].errorDetail!.length).toBe(256);
    });
  });
});
