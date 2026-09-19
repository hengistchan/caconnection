import type { DatabaseSync } from 'node:sqlite';
import {
  CALL_IDENTITY_CORRELATION_WINDOW_MS,
  DEFAULT_NOTIFICATION_RETRY_SECONDS,
  MAX_NOTIFICATION_RETRY_SECONDS,
  NOTIFICATION_CONTENT_MODES,
  NOTIFICATION_DELIVERY_LEASE_MS,
} from '../config/constants.js';
import { queryOne } from '../database/helpers.js';
import { transaction } from '../database/transaction.js';

export type NotificationContentMode = 'REDACTED' | 'FULL';

export interface NotificationSettings {
  channel: 'FEISHU';
  configured: boolean;
  signingEnabled: boolean;
  enabled: boolean;
  contentMode: NotificationContentMode;
  updatedAt: number;
  pendingCount: number;
  retryCount: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

export interface NotificationDelivery {
  id: number;
  eventId: number | null;
  kind: 'EVENT' | 'TEST';
  contentMode: NotificationContentMode;
  attemptCount: number;
  createdAt: number;
  deviceId: string | null;
  eventType: string | null;
  receivedAt: number | null;
  slotIndex: number | null;
  envelopeJson: string | null;
}

interface SettingsRow {
  enabled: number;
  content_mode: NotificationContentMode;
  updated_at: number;
}

interface SummaryRow {
  pending_count: number | null;
  retry_count: number | null;
  last_success_at: number | null;
  last_attempt_at: number | null;
}

interface DeliveryRow {
  id: number;
  event_id: number | null;
  kind: 'EVENT' | 'TEST';
  content_mode: NotificationContentMode;
  attempt_count: number;
  created_at: number;
  device_id: string | null;
  event_type: string | null;
  received_at: number | null;
  slot_index: number | null;
  envelope_json: string | null;
}

export class NotificationRepository {
  constructor(private readonly db: DatabaseSync) {}

  getActiveMode(): NotificationContentMode | null {
    const settings = queryOne<SettingsRow>(this.db, `
      SELECT enabled, content_mode, updated_at
      FROM notification_settings
      WHERE id = 1
    `);
    return settings?.enabled === 1 ? settings.content_mode : null;
  }

  getSettings(configured: boolean, signingEnabled: boolean): NotificationSettings {
    const settings = queryOne<SettingsRow>(this.db, `
      SELECT enabled, content_mode, updated_at
      FROM notification_settings
      WHERE id = 1
    `);
    const summary = queryOne<SummaryRow>(this.db, `
      SELECT
        SUM(CASE WHEN status IN ('PENDING', 'RETRY', 'SENDING') THEN 1 ELSE 0 END)
          AS pending_count,
        SUM(CASE WHEN status = 'RETRY' THEN 1 ELSE 0 END) AS retry_count,
        MAX(CASE WHEN status = 'SENT' THEN sent_at END) AS last_success_at,
        MAX(COALESCE(sent_at, lease_started_at)) AS last_attempt_at
      FROM notification_outbox
    `);
    if (!settings || !summary) throw new Error('notification settings are unavailable');
    return {
      channel: 'FEISHU',
      configured,
      signingEnabled,
      enabled: settings.enabled === 1,
      contentMode: settings.content_mode,
      updatedAt: settings.updated_at,
      pendingCount: summary.pending_count ?? 0,
      retryCount: summary.retry_count ?? 0,
      lastSuccessAt: summary.last_success_at,
      lastAttemptAt: summary.last_attempt_at,
    };
  }

  updateSettings(enabled: boolean, contentMode: string, nowMs: number): void {
    if (!NOTIFICATION_CONTENT_MODES.has(contentMode)) {
      throw new Error('invalid notification content mode');
    }
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE notification_settings
        SET enabled = ?, content_mode = ?, updated_at = ?
        WHERE id = 1
      `).run(enabled ? 1 : 0, contentMode, nowMs);
      if (enabled) {
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'PENDING', next_attempt_at = ?
          WHERE status = 'PAUSED'
        `).run(nowMs);
      } else {
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'PAUSED'
          WHERE status IN ('PENDING', 'RETRY') AND kind = 'EVENT'
        `).run();
      }
    });
  }

  enqueueEvent(
    eventId: number,
    contentMode: NotificationContentMode,
    nowMs: number,
    nextAttemptAt = nowMs,
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO notification_outbox(
        channel, event_id, kind, content_mode, status, attempt_count,
        next_attempt_at, lease_started_at, created_at, sent_at, last_error
      ) VALUES ('FEISHU', ?, 'EVENT', ?, 'PENDING', 0, ?, NULL, ?, NULL, NULL)
    `).run(eventId, contentMode, nextAttemptAt, nowMs);
  }

  findCallIdentityEnvelope(eventId: number): string | null {
    const row = queryOne<{ envelope_json: string }>(this.db, `
      SELECT identity.envelope_json
      FROM events ringing
      JOIN events identity
        ON identity.device_id = ringing.device_id
       AND identity.event_type = 'CALL_IDENTITY'
       AND identity.created_at BETWEEN
         ringing.created_at - 1000
         AND ringing.created_at + ?
       AND (
         ringing.slot_index IS NULL
         OR identity.slot_index IS NULL
         OR identity.slot_index = ringing.slot_index
       )
      WHERE ringing.id = ?
        AND ringing.event_type = 'CALL_STATE'
      ORDER BY ABS(identity.created_at - ringing.created_at), identity.id
      LIMIT 1
    `, CALL_IDENTITY_CORRELATION_WINDOW_MS, eventId);
    return row?.envelope_json ?? null;
  }

  expediteRelatedCallNotification(identityEventId: number, nowMs: number): void {
    this.db.prepare(`
      UPDATE notification_outbox
      SET next_attempt_at = MIN(next_attempt_at, ?)
      WHERE id = (
        SELECT notification.id
        FROM events identity
        JOIN events ringing
          ON ringing.device_id = identity.device_id
         AND ringing.event_type = 'CALL_STATE'
         AND ringing.created_at BETWEEN
           identity.created_at - ?
           AND identity.created_at + 1000
         AND (
           ringing.slot_index IS NULL
           OR identity.slot_index IS NULL
           OR identity.slot_index = ringing.slot_index
         )
        JOIN notification_outbox notification
          ON notification.event_id = ringing.id
         AND notification.status IN ('PENDING', 'RETRY')
        WHERE identity.id = ?
          AND identity.event_type = 'CALL_IDENTITY'
        ORDER BY ABS(identity.created_at - ringing.created_at), notification.id
        LIMIT 1
      )
    `).run(nowMs, CALL_IDENTITY_CORRELATION_WINDOW_MS, identityEventId);
  }

  enqueueTest(nowMs: number): number {
    const settings = queryOne<Pick<SettingsRow, 'content_mode'>>(this.db, `
      SELECT content_mode FROM notification_settings WHERE id = 1
    `);
    if (!settings) throw new Error('notification settings are unavailable');
    const result = this.db.prepare(`
      INSERT INTO notification_outbox(
        channel, event_id, kind, content_mode, status, attempt_count,
        next_attempt_at, lease_started_at, created_at, sent_at, last_error
      ) VALUES ('FEISHU', NULL, 'TEST', ?, 'PENDING', 0, ?, NULL, ?, NULL, NULL)
    `).run(settings.content_mode, nowMs, nowMs);
    return Number(result.lastInsertRowid);
  }

  claimDue(nowMs: number): NotificationDelivery | null {
    return transaction(this.db, () => {
      this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'RETRY', next_attempt_at = ?, lease_started_at = NULL,
            last_error = 'delivery lease expired'
        WHERE status = 'SENDING' AND lease_started_at <= ?
      `).run(nowMs, nowMs - NOTIFICATION_DELIVERY_LEASE_MS);

      const candidate = queryOne<{ id: number }>(this.db, `
        SELECT id FROM notification_outbox
        WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?
          AND (
            kind = 'TEST'
            OR EXISTS (
              SELECT 1 FROM notification_settings
              WHERE id = 1 AND enabled = 1
            )
          )
        ORDER BY id
        LIMIT 1
      `, nowMs);
      if (!candidate) return null;

      const claimed = this.db.prepare(`
        UPDATE notification_outbox
        SET status = 'SENDING', attempt_count = attempt_count + 1,
            lease_started_at = ?, last_error = NULL
        WHERE id = ? AND status IN ('PENDING', 'RETRY')
      `).run(nowMs, candidate.id);
      if (claimed.changes !== 1) return null;

      const row = queryOne<DeliveryRow>(this.db, `
        SELECT n.id, n.event_id, n.kind, n.content_mode, n.attempt_count,
               n.created_at, e.device_id, e.event_type, e.received_at,
               e.slot_index, e.envelope_json
        FROM notification_outbox n
        LEFT JOIN events e ON e.id = n.event_id
        WHERE n.id = ?
      `, candidate.id);
      if (!row) return null;
      return {
        id: row.id,
        eventId: row.event_id,
        kind: row.kind,
        contentMode: row.content_mode,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        deviceId: row.device_id,
        eventType: row.event_type,
        receivedAt: row.received_at,
        slotIndex: row.slot_index,
        envelopeJson: row.envelope_json,
      };
    });
  }

  finish(deliveryId: number, nowMs: number, skipped = false): void {
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = ?, sent_at = ?, lease_started_at = NULL, last_error = NULL
      WHERE id = ? AND status = 'SENDING'
    `).run(skipped ? 'SKIPPED' : 'SENT', nowMs, deliveryId);
  }

  retry(deliveryId: number, attemptCount: number, nowMs: number, error: string): void {
    const retrySeconds = Math.min(
      DEFAULT_NOTIFICATION_RETRY_SECONDS * (2 ** Math.min(Math.max(attemptCount - 1, 0), 8)),
      MAX_NOTIFICATION_RETRY_SECONDS,
    );
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'RETRY', next_attempt_at = ?, lease_started_at = NULL,
          last_error = ?
      WHERE id = ? AND status = 'SENDING'
    `).run(nowMs + retrySeconds * 1000, error.slice(0, 256), deliveryId);
  }
}
