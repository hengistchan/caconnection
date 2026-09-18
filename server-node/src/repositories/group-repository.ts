/**
 * Group repository.
 *
 * Manages gateway groups for organizing devices.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { queryAll, queryOne } from '../database/helpers.js';

export interface GatewayGroup {
  groupId: string;
  name: string;
  deviceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export class GroupRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * List all groups, optionally filtered by allowed device IDs.
   */
  list(allowedDeviceIds?: Set<string> | null): GatewayGroup[] {
    const groups = queryAll<any>(this.db, 'SELECT group_id, name, created_at, updated_at FROM gateway_groups ORDER BY name COLLATE NOCASE, group_id');
    const members = queryAll<any>(this.db, 'SELECT group_id, device_id FROM gateway_group_members ORDER BY device_id');

    const byGroup = new Map<string, string[]>();
    for (const member of members) {
      const deviceId = member.device_id as string;
      if (allowedDeviceIds === undefined || allowedDeviceIds === null || allowedDeviceIds.has(deviceId)) {
        const ids = byGroup.get(member.group_id) || [];
        ids.push(deviceId);
        byGroup.set(member.group_id, ids);
      }
    }

    let result = groups.map(row => ({
      groupId: row.group_id,
      name: row.name,
      deviceIds: byGroup.get(row.group_id) || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    if (allowedDeviceIds !== undefined && allowedDeviceIds !== null) {
      result = result.filter(g => g.deviceIds.length > 0);
    }

    return result;
  }

  /**
   * Get device IDs for a group.
   */
  getDeviceIds(groupId: string): Set<string> | null {
    const exists = queryOne(this.db, 'SELECT 1 FROM gateway_groups WHERE group_id = ?', groupId);
    if (!exists) return null;

    const rows = queryAll<any>(this.db, 'SELECT device_id FROM gateway_group_members WHERE group_id = ?', groupId);
    return new Set(rows.map(r => r.device_id));
  }

  /**
   * Create a new group.
   */
  create(groupId: string, name: string, deviceIds: string[], nowMs: number, knownDevices: Set<string>): GatewayGroup {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) {
      throw new Error('invalid groupId');
    }

    const normalizedName = name.trim();
    if (normalizedName.length < 1 || normalizedName.length > 128) {
      throw new Error('invalid group name');
    }

    if (new Set(deviceIds).size !== deviceIds.length) {
      throw new Error('duplicate deviceId');
    }

    for (const deviceId of deviceIds) {
      if (!knownDevices.has(deviceId)) {
        throw new Error('unknown deviceId');
      }
    }

    transaction(this.db, () => {
      try {
        this.db.prepare('INSERT INTO gateway_groups(group_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(groupId, normalizedName, nowMs, nowMs);
      } catch (error: any) {
        if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.errcode === 1555) {
          throw new Error('group already exists');
        }
        throw error;
      }

      for (const deviceId of deviceIds) {
        this.db.prepare('INSERT INTO gateway_group_members(group_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
      }
    });

    return this.list().find(g => g.groupId === groupId)!;
  }

  /**
   * Update a group.
   */
  update(groupId: string, name?: string, deviceIds?: string[], nowMs?: number, knownDevices?: Set<string>): GatewayGroup | null {
    const exists = queryOne(this.db, 'SELECT 1 FROM gateway_groups WHERE group_id = ?', groupId);
    if (!exists) return null;

    const normalizedName = name?.trim();
    if (normalizedName !== undefined && (normalizedName.length < 1 || normalizedName.length > 128)) {
      throw new Error('invalid group name');
    }

    if (deviceIds && new Set(deviceIds).size !== deviceIds.length) {
      throw new Error('duplicate deviceId');
    }

    if (deviceIds && knownDevices) {
      for (const deviceId of deviceIds) {
        if (!knownDevices.has(deviceId)) {
          throw new Error('unknown deviceId');
        }
      }
    }

    transaction(this.db, () => {
      if (deviceIds) {
        this.db.prepare('DELETE FROM gateway_group_members WHERE group_id = ?').run(groupId);
        for (const deviceId of deviceIds) {
          this.db.prepare('INSERT INTO gateway_group_members(group_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
        }
      }

      if (normalizedName !== undefined) {
        this.db.prepare('UPDATE gateway_groups SET name = ?, updated_at = ? WHERE group_id = ?').run(normalizedName, nowMs || Date.now(), groupId);
      } else {
        this.db.prepare('UPDATE gateway_groups SET updated_at = ? WHERE group_id = ?').run(nowMs || Date.now(), groupId);
      }
    });

    return this.list().find(g => g.groupId === groupId)!;
  }

  /**
   * Delete a group.
   */
  delete(groupId: string): boolean {
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM gateway_group_members WHERE group_id = ?').run(groupId);
      return this.db.prepare('DELETE FROM gateway_groups WHERE group_id = ?').run(groupId).changes > 0;
    });
  }
}
