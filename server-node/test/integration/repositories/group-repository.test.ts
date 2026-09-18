/**
 * Integration tests for GroupRepository.
 *
 * Tests group CRUD, membership, and filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GroupRepository } from '../../../src/repositories/group-repository.js';
import { DeviceRepository } from '../../../src/repositories/device-repository.js';
import { initializeDatabase } from '../../../src/database/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function createTestDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'group-repo-test-'));
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

describe('GroupRepository', () => {
  let db: DatabaseSync;
  let dir: string;
  let groupRepo: GroupRepository;
  let deviceRepo: DeviceRepository;
  let knownDevices: Set<string>;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    groupRepo = new GroupRepository(db);
    deviceRepo = new DeviceRepository(db);

    // Create test devices
    deviceRepo.add('device-1', generateSecret().toString('base64'), 'Device 1', 1000000);
    deviceRepo.add('device-2', generateSecret().toString('base64'), 'Device 2', 1000000);
    deviceRepo.add('device-3', generateSecret().toString('base64'), 'Device 3', 1000000);

    knownDevices = new Set(['device-1', 'device-2', 'device-3']);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a new group', () => {
      const group = groupRepo.create('group-1', 'Test Group', ['device-1', 'device-2'], 1000000, knownDevices);

      expect(group.groupId).toBe('group-1');
      expect(group.name).toBe('Test Group');
      expect(group.deviceIds).toContain('device-1');
      expect(group.deviceIds).toContain('device-2');
      expect(group.createdAt).toBe(1000000);
    });

    it('should reject duplicate group ID', () => {
      groupRepo.create('group-1', 'Group 1', ['device-1'], 1000000, knownDevices);

      expect(() => groupRepo.create('group-1', 'Group 2', ['device-2'], 1000001, knownDevices)).toThrow('already exists');
    });

    it('should reject invalid group ID', () => {
      expect(() => groupRepo.create('invalid id!', 'Group', ['device-1'], 1000000, knownDevices)).toThrow('invalid groupId');
    });

    it('should reject empty group name', () => {
      expect(() => groupRepo.create('group-1', '', ['device-1'], 1000000, knownDevices)).toThrow('invalid group name');
    });

    it('should reject unknown device IDs', () => {
      expect(() => groupRepo.create('group-1', 'Group', ['unknown-device'], 1000000, knownDevices)).toThrow('unknown deviceId');
    });

    it('should reject duplicate device IDs', () => {
      expect(() => groupRepo.create('group-1', 'Group', ['device-1', 'device-1'], 1000000, knownDevices)).toThrow('duplicate deviceId');
    });

    it('should create group with empty device list', () => {
      const group = groupRepo.create('group-1', 'Empty Group', [], 1000000, knownDevices);

      expect(group.deviceIds).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('should list all groups', () => {
      groupRepo.create('group-1', 'Group 1', ['device-1'], 1000000, knownDevices);
      groupRepo.create('group-2', 'Group 2', ['device-2'], 1000001, knownDevices);

      const groups = groupRepo.list();

      expect(groups).toHaveLength(2);
    });

    it('should filter by allowed device IDs', () => {
      groupRepo.create('group-1', 'Group 1', ['device-1'], 1000000, knownDevices);
      groupRepo.create('group-2', 'Group 2', ['device-2'], 1000001, knownDevices);
      groupRepo.create('group-3', 'Group 3', ['device-1', 'device-2'], 1000002, knownDevices);

      const allowed = new Set(['device-1']);
      const groups = groupRepo.list(allowed);

      // Should include groups that have at least one allowed device
      expect(groups).toHaveLength(2); // group-1 and group-3
      expect(groups.every(g => g.deviceIds.some(id => allowed.has(id)))).toBe(true);
    });

    it('should return empty when no groups have allowed devices', () => {
      groupRepo.create('group-1', 'Group 1', ['device-2'], 1000000, knownDevices);

      const allowed = new Set(['device-1']);
      const groups = groupRepo.list(allowed);

      expect(groups).toHaveLength(0);
    });

    it('should sort by name case-insensitive', () => {
      groupRepo.create('group-1', 'Banana', ['device-1'], 1000000, knownDevices);
      groupRepo.create('group-2', 'apple', ['device-2'], 1000001, knownDevices);
      groupRepo.create('group-3', 'Cherry', ['device-3'], 1000002, knownDevices);

      const groups = groupRepo.list();

      expect(groups[0].name).toBe('apple');
      expect(groups[1].name).toBe('Banana');
      expect(groups[2].name).toBe('Cherry');
    });
  });

  describe('getDeviceIds', () => {
    it('should return device IDs for a group', () => {
      groupRepo.create('group-1', 'Group 1', ['device-1', 'device-2'], 1000000, knownDevices);

      const deviceIds = groupRepo.getDeviceIds('group-1');

      expect(deviceIds).not.toBeNull();
      expect(deviceIds!.has('device-1')).toBe(true);
      expect(deviceIds!.has('device-2')).toBe(true);
      expect(deviceIds!.size).toBe(2);
    });

    it('should return null for non-existent group', () => {
      expect(groupRepo.getDeviceIds('non-existent')).toBeNull();
    });
  });

  describe('update', () => {
    it('should update group name', () => {
      groupRepo.create('group-1', 'Original', ['device-1'], 1000000, knownDevices);

      const updated = groupRepo.update('group-1', 'Updated', undefined, 1000001, knownDevices);

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated');
      expect(updated!.updatedAt).toBe(1000001);
    });

    it('should update group members', () => {
      groupRepo.create('group-1', 'Group', ['device-1'], 1000000, knownDevices);

      const updated = groupRepo.update('group-1', undefined, ['device-2', 'device-3'], 1000001, knownDevices);

      expect(updated).not.toBeNull();
      expect(updated!.deviceIds).toContain('device-2');
      expect(updated!.deviceIds).toContain('device-3');
      expect(updated!.deviceIds).not.toContain('device-1');
    });

    it('should update both name and members', () => {
      groupRepo.create('group-1', 'Original', ['device-1'], 1000000, knownDevices);

      const updated = groupRepo.update('group-1', 'New Name', ['device-2'], 1000001, knownDevices);

      expect(updated!.name).toBe('New Name');
      expect(updated!.deviceIds).toEqual(['device-2']);
    });

    it('should return null for non-existent group', () => {
      const updated = groupRepo.update('non-existent', 'Name', undefined, 1000000, knownDevices);
      expect(updated).toBeNull();
    });

    it('should reject invalid group name', () => {
      groupRepo.create('group-1', 'Group', ['device-1'], 1000000, knownDevices);

      expect(() => groupRepo.update('group-1', '', undefined, 1000001, knownDevices)).toThrow('invalid group name');
    });

    it('should reject duplicate device IDs', () => {
      groupRepo.create('group-1', 'Group', ['device-1'], 1000000, knownDevices);

      expect(() => groupRepo.update('group-1', undefined, ['device-1', 'device-1'], 1000001, knownDevices)).toThrow('duplicate deviceId');
    });

    it('should reject unknown device IDs', () => {
      groupRepo.create('group-1', 'Group', ['device-1'], 1000000, knownDevices);

      expect(() => groupRepo.update('group-1', undefined, ['unknown'], 1000001, knownDevices)).toThrow('unknown deviceId');
    });
  });

  describe('delete', () => {
    it('should delete a group', () => {
      groupRepo.create('group-1', 'Group', ['device-1'], 1000000, knownDevices);

      const deleted = groupRepo.delete('group-1');

      expect(deleted).toBe(true);
      expect(groupRepo.list()).toHaveLength(0);
    });

    it('should return false for non-existent group', () => {
      expect(groupRepo.delete('non-existent')).toBe(false);
    });

    it('should cascade delete members', () => {
      groupRepo.create('group-1', 'Group', ['device-1', 'device-2'], 1000000, knownDevices);

      groupRepo.delete('group-1');

      const deviceIds = groupRepo.getDeviceIds('group-1');
      expect(deviceIds).toBeNull();
    });
  });
});