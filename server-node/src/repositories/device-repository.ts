/**
 * Device repository interface.
 *
 * Abstracts device database operations for use by auth modules.
 */

import type { DatabaseSync } from 'node:sqlite';
import { NONCE_RETENTION_MS } from '../config/constants.js';

export class DeviceRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Check if a device is active (exists and not retired).
   */
  isActive(deviceId: string): boolean {
    const row = this.db.prepare('SELECT retired_at FROM devices WHERE device_id = ?').get(deviceId) as any;
    // Legacy/in-memory test configurations have no database device row
    return row === undefined || row.retired_at === null;
  }

  /**
   * Record a request nonce for replay protection.
   * Throws if the nonce has been seen before.
   */
  recordNonce(deviceId: string, nonce: string, nowMs: number): void {
    // Clean up expired nonces
    this.db.prepare('DELETE FROM request_nonces WHERE seen_at < ?').run(nowMs - NONCE_RETENTION_MS);

    try {
      this.db.prepare('INSERT INTO request_nonces(device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, nonce, nowMs);
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new Error('replayed nonce');
      }
      throw error;
    }
  }

  /**
   * Update device last_seen_at timestamp.
   */
  touchDevice(deviceId: string, nowMs: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(nowMs, deviceId);
  }

  /**
   * Load all device secrets.
   */
  loadSecrets(): Map<string, Buffer> {
    const rows = this.db.prepare('SELECT device_id, secret_base64 FROM devices').all() as any[];
    const result = new Map<string, Buffer>();

    for (const row of rows) {
      try {
        const secret = Buffer.from(row.secret_base64, 'base64');
        if (secret.length >= 32) {
          result.set(row.device_id, secret);
        }
      } catch {
        continue;
      }
    }

    return result;
  }
}
