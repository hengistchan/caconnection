/**
 * OTP repository.
 *
 * Manages OTP claims for one-time password extraction.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { queryAll } from '../database/helpers.js';
import { decryptPayload } from '../crypto/payload-crypto.js';
import { extractOtpCandidates } from '../crypto/otp-extraction.js';

export interface OtpClaim {
  eventId: number;
  deviceId: string;
  receivedAt: number;
  subscriptionId: number | null;
  slotIndex: number | null;
  code: string;
  expiresAt: number;
}

export class OtpRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Claim the latest unclaimed OTP.
   */
  claimLatest(
    secrets: Map<string, Buffer>,
    clientId: string,
    nowMs: number,
    maxAgeSeconds: number,
    options: {
      slotIndex?: number;
      eventId?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): OtpClaim | null {
    const cutoff = nowMs - maxAgeSeconds * 1000;
    const clauses = [
      "e.event_type = 'INCOMING_SMS'",
      'e.received_at >= ?',
      'c.event_id IS NULL',
    ];
    const params: any[] = [cutoff];

    if (options.slotIndex !== undefined) {
      clauses.push('e.slot_index = ?');
      params.push(options.slotIndex);
    }
    if (options.eventId !== undefined) {
      clauses.push('e.id = ?');
      params.push(options.eventId);
    }
    if (options.deviceId !== undefined) {
      clauses.push('e.device_id = ?');
      params.push(options.deviceId);
    }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) return null;
      const ids = [...options.deviceIds].sort();
      clauses.push(`e.device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    return transaction(this.db, () => {
      const rows = queryAll<any>(this.db, `
        SELECT e.id, e.device_id, e.received_at, e.subscription_id, e.slot_index, e.envelope_json
        FROM events e
        LEFT JOIN otp_claims c ON c.event_id = e.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.received_at DESC
      `, ...params);

      for (const row of rows) {
        const secret = secrets.get(row.device_id);
        if (!secret) continue;

        const envelope = decryptPayload(JSON.parse(row.envelope_json), row.device_id, secret);
        const body = (envelope.payload as Record<string, unknown>).body as string | null;
        const candidates = extractOtpCandidates(body);
        if (candidates.length === 0) continue;

        // Try to claim atomically
        const result = this.db.prepare('INSERT OR IGNORE INTO otp_claims(event_id, client_id, claimed_at) VALUES (?, ?, ?)').run(row.id, clientId, nowMs);
        if (result.changes === 0) continue;

        return {
          eventId: row.id,
          deviceId: row.device_id,
          receivedAt: row.received_at,
          subscriptionId: row.subscription_id,
          slotIndex: row.slot_index,
          code: candidates[0]!,
          expiresAt: row.received_at + maxAgeSeconds * 1000,
        };
      }

      return null;
    });
  }
}
