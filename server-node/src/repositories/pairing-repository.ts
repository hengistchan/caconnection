/**
 * Pairing repository.
 *
 * Manages pairing sessions for Android device provisioning.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { transaction } from '../database/transaction.js';

export class PairingRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Create a new pairing session.
   */
  create(
    token: string,
    deviceId: string,
    nowMs: number,
    expiresInSeconds: number,
  ): number {
    const tokenDigest = createHash('sha256').update(token, 'ascii').digest('hex');
    const expiresAt = nowMs + expiresInSeconds * 1000;

    transaction(this.db, () => {
      // Clean up old expired sessions
      this.db.prepare('DELETE FROM pairing_sessions WHERE expires_at < ?').run(nowMs - 86_400_000);

      // Consume existing active sessions for this device
      this.db.prepare('UPDATE pairing_sessions SET consumed_at = ? WHERE device_id = ? AND consumed_at IS NULL AND expires_at >= ?').run(nowMs, deviceId, nowMs);

      // Create new session
      this.db.prepare('INSERT INTO pairing_sessions(token_sha256, device_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)').run(tokenDigest, deviceId, nowMs, expiresAt);
    });

    return expiresAt;
  }

  /**
   * Claim a pairing session with a token.
   * Returns the device ID if successful, null otherwise.
   */
  claim(token: string, nowMs: number): string | null {
    const tokenDigest = createHash('sha256').update(token, 'ascii').digest('hex');

    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT device_id FROM pairing_sessions WHERE token_sha256 = ? AND consumed_at IS NULL AND expires_at >= ?').get(tokenDigest, nowMs) as { device_id: string } | undefined;

      if (!row) return null;

      const result = this.db.prepare('UPDATE pairing_sessions SET consumed_at = ? WHERE token_sha256 = ? AND consumed_at IS NULL').run(nowMs, tokenDigest);
      if (result.changes !== 1) return null;

      return row.device_id;
    });
  }
}
