/**
 * Event repository.
 *
 * Manages the events table and provides query methods for messages and notifications.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { queryAll } from '../database/helpers.js';
import { decryptPayload } from '../crypto/payload-crypto.js';
import { extractOtpCandidates } from '../crypto/otp-extraction.js';
import { ReplayedNonceError } from '../auth/auth-errors.js';

export interface EventRow {
  id: number;
  device_id: string;
  idempotency_key: string;
  delivery_id: string;
  source_event_id: string;
  event_type: string;
  created_at: number;
  received_at: number;
  subscription_id: number | null;
  slot_index: number | null;
  envelope_json: string;
}

export interface IncomingMessage {
  id: number;
  deviceId: string;
  createdAt: number;
  receivedAt: number;
  subscriptionId: number | null;
  slotIndex: number | null;
  sender: string | null;
  body: string | null;
  partCount: number | null;
  resolutionMethod: string | null;
  resolutionConfidence: string | null;
  otpCandidates: string[];
}

export interface CapturedNotification {
  id: number;
  deviceId: string;
  createdAt: number;
  receivedAt: number;
  eventType: string | null;
  sourcePackage: string | null;
  notificationId: number | null;
  postedAt: number | null;
  observedAt: number | null;
  channelId: string | null;
  category: string | null;
  title: string | null;
  body: string | null;
}

export interface EventInsertResult {
  inserted: boolean;
  eventId: number | null;
}

export interface MessageQueryResult {
  messages: IncomingMessage[];
  unreadableRecords: number;
}

export interface NotificationQueryResult {
  notifications: CapturedNotification[];
  unreadableRecords: number;
}

export class EventRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Accept an event with idempotency and nonce protection.
   */
  accept(
    deviceId: string,
    idempotencyKey: string,
    nonce: string,
    envelope: Record<string, unknown>,
    nowMs: number,
  ): boolean {
    return transaction(this.db, () => {
      this.recordNonce(deviceId, nonce, nowMs);
      return this.insertWithId(deviceId, idempotencyKey, envelope, nowMs).inserted;
    });
  }

  recordNonce(deviceId: string, nonce: string, nowMs: number): void {
    this.db.prepare('DELETE FROM request_nonces WHERE seen_at < ?').run(nowMs - 600_000);
    try {
      this.db.prepare('INSERT INTO request_nonces(device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, nonce, nowMs);
    } catch (error: any) {
      if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.errcode === 1555) {
        throw new ReplayedNonceError();
      }
      throw error;
    }
  }

  /**
   * Insert one event without opening a transaction. Ingestion uses this to
   * atomically compose nonce, event and side-effect writes.
   */
  insert(
    deviceId: string,
    idempotencyKey: string,
    envelope: Record<string, unknown>,
    nowMs: number,
  ): boolean {
    return this.insertWithId(deviceId, idempotencyKey, envelope, nowMs).inserted;
  }

  claimCallSessionRinging(
    deviceId: string,
    sessionId: string,
    eventId: number,
    nowMs: number,
  ): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO call_ringing_sessions(
        device_id, session_id, first_event_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(deviceId, sessionId, eventId, nowMs);
    return result.changes > 0;
  }

  markCallSessionAnswered(deviceId: string, sessionId: string, nowMs: number): void {
    this.db.prepare(`
      UPDATE call_ringing_sessions
      SET answered_at = COALESCE(answered_at, ?)
      WHERE device_id = ? AND session_id = ? AND ended_at IS NULL
    `).run(nowMs, deviceId, sessionId);
  }

  claimCallSessionEnded(
    deviceId: string,
    sessionId: string,
    eventId: number,
    nowMs: number,
  ): 'call.missed' | 'call.ended' | null {
    const row = this.db.prepare(`
      UPDATE call_ringing_sessions
      SET ended_at = ?, ended_event_id = ?
      WHERE device_id = ? AND session_id = ? AND ended_at IS NULL
      RETURNING answered_at
    `).get(
      nowMs,
      eventId,
      deviceId,
      sessionId,
    ) as { answered_at: number | null } | undefined;
    if (!row) return null;
    return row.answered_at === null ? 'call.missed' : 'call.ended';
  }

  insertWithId(
    deviceId: string,
    idempotencyKey: string,
    envelope: Record<string, unknown>,
    nowMs: number,
  ): EventInsertResult {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events(
        device_id, idempotency_key, delivery_id, source_event_id,
        event_type, created_at, received_at, subscription_id, slot_index, envelope_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      idempotencyKey,
      envelope.deliveryId as string,
      envelope.sourceEventId as string,
      envelope.eventType as string,
      envelope.createdAt as number,
      nowMs,
      (envelope.subscriptionId as number) ?? null,
      (envelope.slotIndex as number) ?? null,
      JSON.stringify(envelope),
    );
    return {
      inserted: result.changes > 0,
      eventId: result.changes > 0 ? Number(result.lastInsertRowid) : null,
    };
  }

  /**
   * Get incoming messages with pagination.
   */
  getMessages(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      afterId?: number;
      beforeId?: number;
      slotIndex?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): IncomingMessage[] {
    return this.getMessagesResult(secrets, limit, options).messages;
  }

  getMessagesResult(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      afterId?: number;
      beforeId?: number;
      slotIndex?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): MessageQueryResult {
    const clauses = ["event_type = 'INCOMING_SMS'"];
    const params: (string | number | null)[] = [];

    if (options.afterId !== undefined) { clauses.push('id > ?'); params.push(options.afterId); }
    if (options.beforeId !== undefined) { clauses.push('id < ?'); params.push(options.beforeId); }
    if (options.slotIndex !== undefined) { clauses.push('slot_index = ?'); params.push(options.slotIndex); }
    if (options.deviceId !== undefined) { clauses.push('device_id = ?'); params.push(options.deviceId); }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) {
        return { messages: [], unreadableRecords: 0 };
      }
      const ids = [...options.deviceIds].sort();
      clauses.push(`device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    params.push(Math.min(Math.max(limit, 1), 100));

    const rows = queryAll<EventRow>(this.db, `
      SELECT id, device_id, created_at, received_at, subscription_id, slot_index, envelope_json
      FROM events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?
    `, ...params);

    const messages: IncomingMessage[] = [];
    let unreadableRecords = 0;
    for (const row of rows) {
      try {
        const secret = secrets.get(row.device_id);
        if (!secret) continue;
        const envelope = decryptPayload(JSON.parse(row.envelope_json), row.device_id, secret);
        const payload = envelope.payload as Record<string, unknown>;
        const body = typeof payload.body === 'string' ? payload.body : null;
        messages.push({
          id: row.id,
          deviceId: row.device_id,
          createdAt: row.created_at,
          receivedAt: row.received_at,
          subscriptionId: row.subscription_id,
          slotIndex: row.slot_index,
          sender: (payload.originatingAddress as string) || null,
          body,
          partCount: (payload.partCount as number) || null,
          resolutionMethod: (payload.resolutionMethod as string) || null,
          resolutionConfidence: (payload.resolutionConfidence as string) || null,
          otpCandidates: extractOtpCandidates(body),
        });
      } catch {
        unreadableRecords += 1;
      }
    }
    return { messages, unreadableRecords };
  }

  /**
   * Get notifications with pagination.
   */
  getNotifications(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      afterId?: number;
      beforeId?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): CapturedNotification[] {
    return this.getNotificationsResult(secrets, limit, options).notifications;
  }

  getNotificationsResult(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      afterId?: number;
      beforeId?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): NotificationQueryResult {
    const clauses = ["event_type = 'NOTIFICATION'"];
    const params: (string | number | null)[] = [];

    if (options.afterId !== undefined) { clauses.push('id > ?'); params.push(options.afterId); }
    if (options.beforeId !== undefined) { clauses.push('id < ?'); params.push(options.beforeId); }
    if (options.deviceId !== undefined) { clauses.push('device_id = ?'); params.push(options.deviceId); }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) {
        return { notifications: [], unreadableRecords: 0 };
      }
      const ids = [...options.deviceIds].sort();
      clauses.push(`device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    params.push(Math.min(Math.max(limit, 1), 100));

    const rows = queryAll<EventRow>(this.db, `
      SELECT id, device_id, created_at, received_at, envelope_json
      FROM events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?
    `, ...params);

    const notifications: CapturedNotification[] = [];
    let unreadableRecords = 0;
    for (const row of rows) {
      try {
        const secret = secrets.get(row.device_id);
        if (!secret) continue;
        const envelope = decryptPayload(JSON.parse(row.envelope_json), row.device_id, secret);
        const payload = envelope.payload as Record<string, unknown>;
        notifications.push({
          id: row.id,
          deviceId: row.device_id,
          createdAt: row.created_at,
          receivedAt: row.received_at,
          eventType: typeof payload.eventType === 'string' ? payload.eventType : null,
          sourcePackage: typeof payload.sourcePackage === 'string' ? payload.sourcePackage : null,
          notificationId: typeof payload.notificationId === 'number' ? payload.notificationId : null,
          postedAt: typeof payload.postedAt === 'number' ? payload.postedAt : null,
          observedAt: typeof payload.observedAt === 'number' ? payload.observedAt : null,
          channelId: typeof payload.channelId === 'string' ? payload.channelId : null,
          category: typeof payload.category === 'string' ? payload.category : null,
          title: typeof payload.title === 'string' ? payload.title : null,
          body: typeof payload.body === 'string' ? payload.body : null,
        });
      } catch {
        unreadableRecords += 1;
      }
    }
    return { notifications, unreadableRecords };
  }

  /**
   * Get latest events (for viewer).
   */
  getLatest(limit: number = 100): EventRow[] {
    return queryAll<EventRow>(this.db, `
      SELECT id, device_id, idempotency_key, event_type, created_at, received_at,
             subscription_id, slot_index, envelope_json
      FROM events ORDER BY id DESC LIMIT ?
    `, Math.min(Math.max(limit, 1), 500));
  }

  /**
   * Prune old events.
   */
  prune(retentionDays: number, nowMs: number): number {
    return transaction(this.db, () => this.pruneInTransaction(retentionDays, nowMs));
  }

  pruneInTransaction(retentionDays: number, nowMs: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = nowMs - retentionDays * 86_400_000;
    this.db.prepare(`
      DELETE FROM notification_outbox
      WHERE event_id IN (SELECT id FROM events WHERE received_at < ?)
         OR (event_id IS NULL AND created_at < ?)
    `).run(cutoff, cutoff);
    this.db.prepare('DELETE FROM otp_claims WHERE event_id IN (SELECT id FROM events WHERE received_at < ?)').run(cutoff);
    return this.db.prepare('DELETE FROM events WHERE received_at < ?').run(cutoff).changes as number;
  }

  /**
   * Clear all events (for viewer).
   */
  clear(): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM notification_outbox').run();
      this.db.prepare('DELETE FROM otp_claims').run();
      this.db.prepare('DELETE FROM events').run();
      this.db.prepare('DELETE FROM request_nonces').run();
      this.db.prepare('DELETE FROM pairing_sessions').run();
      this.db.prepare('DELETE FROM outbound_commands').run();
    });
  }
}
