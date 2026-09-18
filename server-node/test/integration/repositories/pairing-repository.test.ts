/**
 * Integration tests for PairingRepository.
 *
 * Tests pairing session creation, claiming, and expiration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PairingRepository } from '../../../src/repositories/pairing-repository.js';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-repo-test-'));
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

describe('PairingRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let pairingRepo: PairingRepository;
  let deviceRepo: DeviceRepository;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    pairingRepo = new PairingRepository(db);
    deviceRepo = new DeviceRepository(db);

    // Create test device
    deviceRepo.add('test-device', generateSecret().toString('base64'), 'Test device', 1000000);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a pairing session', () => {
      const expiresAt = pairingRepo.create('token-123', 'test-device', 1000000, 300);

      expect(expiresAt).toBe(1000000 + 300 * 1000);
    });

    it('should consume existing active sessions for the same device', () => {
      pairingRepo.create('token-1', 'test-device', 1000000, 300);
      pairingRepo.create('token-2', 'test-device', 1000001, 300);

      // First token should be consumed
      const claimed = pairingRepo.claim('token-1', 1000002);
      expect(claimed).toBeNull(); // Already consumed
    });

    it('should clean up old expired sessions', () => {
      // Create an old expired session
      pairingRepo.create('old-token', 'test-device', 1000000, 1); // 1 second expiry

      // Create a new session after old one expired
      pairingRepo.create('new-token', 'test-device', 1000002 + 86400000, 300);

      // Old token should not be claimable
      const claimed = pairingRepo.claim('old-token', 1000003 + 86400000);
      expect(claimed).toBeNull();
    });
  });

  describe('claim', () => {
    it('should claim a valid pairing session', () => {
      pairingRepo.create('token-123', 'test-device', 1000000, 300);

      const deviceId = pairingRepo.claim('token-123', 1000001);

      expect(deviceId).toBe('test-device');
    });

    it('should return null for expired token', () => {
      const expiresInSeconds = 1;
      pairingRepo.create('token-123', 'test-device', 1000000, expiresInSeconds);

      // expires_at = 1000000 + 1000 = 1001000
      // Try to claim after expiry
      const deviceId = pairingRepo.claim('token-123', 1001001);

      expect(deviceId).toBeNull();
    });

    it('should return null for already consumed token', () => {
      pairingRepo.create('token-123', 'test-device', 1000000, 300);

      pairingRepo.claim('token-123', 1000001);
      const secondClaim = pairingRepo.claim('token-123', 1000002);

      expect(secondClaim).toBeNull();
    });

    it('should return null for unknown token', () => {
      const deviceId = pairingRepo.claim('unknown-token', 1000000);

      expect(deviceId).toBeNull();
    });

    it('should not allow claiming with modified token', () => {
      pairingRepo.create('token-123', 'test-device', 1000000, 300);

      const deviceId = pairingRepo.claim('token-123-modified', 1000001);

      expect(deviceId).toBeNull();
    });
  });

  describe('concurrent claims', () => {
    it('should only allow one successful claim', () => {
      pairingRepo.create('token-123', 'test-device', 1000000, 300);

      // Simulate concurrent claims
      const results: Array<string | null> = [];
      for (let i = 0; i < 5; i++) {
        try {
          const deviceId = pairingRepo.claim('token-123', 1000001);
          results.push(deviceId);
        } catch {
          results.push(null);
        }
      }

      // Only one should succeed
      const successful = results.filter(r => r !== null);
      expect(successful).toHaveLength(1);
      expect(successful[0]).toBe('test-device');
    });
  });
});