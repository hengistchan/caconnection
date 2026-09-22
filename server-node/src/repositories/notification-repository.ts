import type { DatabaseSync } from 'node:sqlite';
import type { NotificationChannelConfig } from '../config/runtime-config.js';
import {
  CALL_IDENTITY_CORRELATION_WINDOW_MS,
  NOTIFICATION_CHANNEL_EVENT_TYPES,
  NOTIFICATION_CONTENT_MODES,
  NOTIFICATION_DELIVERY_LEASE_MS,
} from '../config/constants.js';
import { queryOne } from '../database/helpers.js';
import { transaction } from '../database/transaction.js';

export type NotificationContentMode = 'REDACTED' | 'FULL';
export type NotificationChannelEventType =
  | 'sms.received'
  | 'call.ringing'
  | 'call.missed'
  | 'call.ended'
  | 'notification.received';

export interface NotificationChannelState {
  id: string;
  name: string;
  type: NotificationChannelConfig['type'];
  configured: boolean;
  signingEnabled: boolean;
  enabled: boolean;
  contentMode: NotificationContentMode;
  eventTypes: NotificationChannelEventType[];
  updatedAt: number;
  pendingCount: number;
  retryCount: number;
  failedCount: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

export interface ActiveNotificationChannel {
  id: string;
  contentMode: NotificationContentMode;
}

export interface NotificationDelivery {
  id: number;
  channelId?: string;
  eventId: number | null;
  kind: 'EVENT' | 'TEST';
  notificationEventType?: NotificationChannelEventType | 'channel.test' | null;
  contentMode: NotificationContentMode;
  attemptCount: number;
  createdAt: number;
  deviceId: string | null;
  eventType: string | null;
  receivedAt: number | null;
  slotIndex: number | null;
  envelopeJson: string | null;
}

interface ChannelRow {
  channel_id: string;
  name: string;
  type: NotificationChannelConfig['type'];
  configured: number;
  signing_enabled: number;
  enabled: number;
  content_mode: NotificationContentMode;
  event_types_json: string;
  updated_at: number;
  pending_count: number | null;
  retry_count: number | null;
  failed_count: number | null;
  last_success_at: number | null;
  last_attempt_at: number | null;
}

interface DeliveryRow {
  id: number;
  channel: string;
  event_id: number | null;
  kind: 'EVENT' | 'TEST';
  notification_event_type: NotificationChannelEventType | 'channel.test' | null;
  content_mode: NotificationContentMode;
  attempt_count: number;
  created_at: number;
  device_id: string | null;
  event_type: string | null;
  received_at: number | null;
  slot_index: number | null;
  envelope_json: string | null;
}

const DEFAULT_EVENTS: NotificationChannelEventType[] = [
  'sms.received',
  'call.ringing',
  'call.missed',
];

export class NotificationRepository {
  constructor(private readonly db: DatabaseSync) {}

  syncConfiguredChannels(channels: NotificationChannelConfig[], nowMs: number): void {
    transaction(this.db, () => {
      const configuredIds = new Set(channels.map(channel => channel.id));
      for (const channel of channels) {
        if (channel.id === 'feishu') {
          this.db.prepare(`
            UPDATE notification_outbox
            SET channel = 'feishu'
            WHERE channel = 'FEISHU'
          `).run();
        }
        const legacy = channel.id === 'feishu'
          ? queryOne<{ enabled: number; content_mode: NotificationContentMode; updated_at: number }>(
            this.db,
            'SELECT enabled, content_mode, updated_at FROM notification_settings WHERE id = 1',
          )
          : null;
        this.db.prepare(`
          INSERT INTO notification_channels(
            channel_id, name, type, enabled, content_mode, event_types_json,
            configured, signing_enabled, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(channel_id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            configured = 1,
            signing_enabled = excluded.signing_enabled
        `).run(
          channel.id,
          channel.name,
          channel.type,
          legacy?.enabled ?? 0,
          legacy?.content_mode ?? 'REDACTED',
          JSON.stringify(DEFAULT_EVENTS),
          channel.type === 'FEISHU' && channel.signingSecret ? 1 : 0,
          legacy?.updated_at || nowMs,
        );
      }
      const rows = this.db.prepare('SELECT channel_id FROM notification_channels').all() as Array<{ channel_id: string }>;
      for (const row of rows) {
        if (!configuredIds.has(row.channel_id)) {
          this.db.prepare(`
            UPDATE notification_channels
            SET configured = 0, enabled = 0, updated_at = ?
            WHERE channel_id = ?
          `).run(nowMs, row.channel_id);
          this.db.prepare(`
            UPDATE notification_outbox
            SET status = 'PAUSED'
            WHERE channel = ? AND status IN ('PENDING', 'RETRY')
          `).run(row.channel_id);
        }
      }
    });
  }

  getActiveChannels(
    eventType: NotificationChannelEventType,
    excludedTypes: NotificationChannelConfig['type'][] = [],
  ): ActiveNotificationChannel[] {
    const rows = this.db.prepare(`
      SELECT channel_id, type, content_mode, event_types_json
      FROM notification_channels
      WHERE enabled = 1 AND configured = 1
      ORDER BY channel_id
    `).all() as Array<{
      channel_id: string;
      type: NotificationChannelConfig['type'];
      content_mode: NotificationContentMode;
      event_types_json: string;
    }>;
    return rows
      .filter(row => (
        !excludedTypes.includes(row.type)
        && parseEventTypes(row.event_types_json).includes(eventType)
      ))
      .map(row => ({ id: row.channel_id, contentMode: row.content_mode }));
  }

  getChannels(): NotificationChannelState[] {
    const rows = this.db.prepare(`
      SELECT c.*,
        SUM(CASE WHEN o.status IN ('PENDING', 'RETRY', 'SENDING') THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN o.status = 'RETRY' THEN 1 ELSE 0 END) AS retry_count,
        SUM(CASE WHEN o.status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
        MAX(CASE WHEN o.status = 'SENT' THEN o.sent_at END) AS last_success_at,
        MAX(COALESCE(o.sent_at, o.lease_started_at)) AS last_attempt_at
      FROM notification_channels c
      LEFT JOIN notification_outbox o ON o.channel = c.channel_id
      GROUP BY c.channel_id
      ORDER BY c.name COLLATE NOCASE, c.channel_id
    `).all() as unknown as ChannelRow[];
    return rows.map(row => ({
      id: row.channel_id,
      name: row.name,
      type: row.type,
      configured: row.configured === 1,
      signingEnabled: row.signing_enabled === 1,
      enabled: row.enabled === 1,
      contentMode: row.content_mode,
      eventTypes: parseEventTypes(row.event_types_json),
      updatedAt: row.updated_at,
      pendingCount: row.pending_count ?? 0,
      retryCount: row.retry_count ?? 0,
      failedCount: row.failed_count ?? 0,
      lastSuccessAt: row.last_success_at,
      lastAttemptAt: row.last_attempt_at,
    }));
  }

  getChannel(channelId: string): NotificationChannelState | null {
    return this.getChannels().find(channel => channel.id === channelId) ?? null;
  }

  updateChannel(
    channelId: string,
    enabled: boolean,
    contentMode: string,
    eventTypes: string[],
    nowMs: number,
  ): boolean {
    if (!NOTIFICATION_CONTENT_MODES.has(contentMode)) {
      throw new Error('invalid notification content mode');
    }
    if (
      eventTypes.length === 0
      || eventTypes.some(eventType => !NOTIFICATION_CHANNEL_EVENT_TYPES.has(eventType))
      || new Set(eventTypes).size !== eventTypes.length
    ) {
      throw new Error('invalid notification event types');
    }
    return transaction(this.db, () => {
      const result = this.db.prepare(`
        UPDATE notification_channels
        SET enabled = ?, content_mode = ?, event_types_json = ?, updated_at = ?
        WHERE channel_id = ? AND configured = 1
      `).run(enabled ? 1 : 0, contentMode, JSON.stringify(eventTypes), nowMs, channelId);
      if (result.changes !== 1) return false;
      if (enabled) {
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'PENDING', next_attempt_at = ?
          WHERE channel = ? AND status = 'PAUSED'
        `).run(nowMs, channelId);
      } else {
        this.db.prepare(`
          UPDATE notification_outbox
          SET status = 'PAUSED'
          WHERE channel = ? AND status IN ('PENDING', 'RETRY') AND kind = 'EVENT'
        `).run(channelId);
      }
      return true;
    });
  }

  enqueueEvent(
    eventId: number,
    channels: ActiveNotificationChannel[],
    notificationEventType: NotificationChannelEventType,
    nowMs: number,
    nextAttemptAt = nowMs,
  ): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO notification_outbox(
        channel, event_id, kind, notification_event_type, content_mode, status, attempt_count,
        next_attempt_at, lease_started_at, created_at, sent_at, last_error
      ) VALUES (?, ?, 'EVENT', ?, ?, 'PENDING', 0, ?, NULL, ?, NULL, NULL)
    `);
    for (const channel of channels) {
      insert.run(
        channel.id,
        eventId,
        notificationEventType,
        channel.contentMode,
        nextAttemptAt,
        nowMs,
      );
    }
  }

  findCallIdentityEnvelope(eventId: number): string | null {
    const row = queryOne<{ envelope_json: string }>(this.db, `
      SELECT identity.envelope_json
      FROM events target
      JOIN call_ringing_sessions session
        ON session.device_id = target.device_id
       AND (
         session.first_event_id = target.id
         OR session.ended_event_id = target.id
       )
      JOIN events ringing ON ringing.id = session.first_event_id
      JOIN events identity
        ON identity.device_id = target.device_id
       AND identity.event_type = 'CALL_IDENTITY'
       AND identity.created_at BETWEEN
         ringing.created_at - 1000
         AND CASE
           WHEN target.id = ringing.id THEN ringing.created_at + ?
           ELSE target.created_at + 1000
         END
       AND (
         ringing.slot_index IS NULL OR identity.slot_index IS NULL
         OR identity.slot_index = ringing.slot_index
       )
      WHERE target.id = ? AND target.event_type = 'CALL_STATE'
      ORDER BY ABS(identity.created_at - ringing.created_at), identity.id
      LIMIT 1
    `, CALL_IDENTITY_CORRELATION_WINDOW_MS, eventId);
    return row?.envelope_json ?? null;
  }

  expediteRelatedCallNotification(identityEventId: number, nowMs: number): void {
    this.db.prepare(`
      UPDATE notification_outbox
      SET next_attempt_at = MIN(next_attempt_at, ?)
      WHERE event_id = (
        SELECT ringing.id
        FROM events identity
        JOIN events ringing
          ON ringing.device_id = identity.device_id
         AND ringing.event_type = 'CALL_STATE'
         AND ringing.created_at BETWEEN identity.created_at - ? AND identity.created_at + 1000
         AND (
           ringing.slot_index IS NULL OR identity.slot_index IS NULL
           OR identity.slot_index = ringing.slot_index
         )
        WHERE identity.id = ? AND identity.event_type = 'CALL_IDENTITY'
        ORDER BY ABS(identity.created_at - ringing.created_at), ringing.id
        LIMIT 1
      )
      AND status IN ('PENDING', 'RETRY')
    `).run(nowMs, CALL_IDENTITY_CORRELATION_WINDOW_MS, identityEventId);
  }

  enqueueTest(channelId: string, nowMs: number): number | null {
    const channel = queryOne<{ content_mode: NotificationContentMode }>(this.db, `
      SELECT content_mode FROM notification_channels
      WHERE channel_id = ? AND configured = 1
    `, channelId);
    if (!channel) return null;
    const result = this.db.prepare(`
      INSERT INTO notification_outbox(
        channel, event_id, kind, notification_event_type, content_mode, status, attempt_count,
        next_attempt_at, lease_started_at, created_at, sent_at, last_error
      ) VALUES (?, NULL, 'TEST', 'channel.test', ?, 'PENDING', 0, ?, NULL, ?, NULL, NULL)
    `).run(channelId, channel.content_mode, nowMs, nowMs);
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
        SELECT o.id
        FROM notification_outbox o
        JOIN notification_channels c ON c.channel_id = o.channel
        WHERE o.status IN ('PENDING', 'RETRY') AND o.next_attempt_at <= ?
          AND c.configured = 1
          AND (o.kind = 'TEST' OR c.enabled = 1)
        ORDER BY o.id
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
        SELECT n.id, n.channel, n.event_id, n.kind, n.notification_event_type,
               n.content_mode, n.attempt_count,
               n.created_at, e.device_id, e.event_type, e.received_at,
               e.slot_index, e.envelope_json
        FROM notification_outbox n
        LEFT JOIN events e ON e.id = n.event_id
        WHERE n.id = ?
      `, candidate.id);
      if (!row) return null;
      return {
        id: row.id,
        channelId: row.channel,
        eventId: row.event_id,
        kind: row.kind,
        notificationEventType: row.notification_event_type,
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
    const delays = [5_000, 30_000, 120_000];
    const delay = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]!;
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'RETRY', next_attempt_at = ?, lease_started_at = NULL, last_error = ?
      WHERE id = ? AND status = 'SENDING'
    `).run(nowMs + delay, error.slice(0, 256), deliveryId);
  }

  fail(deliveryId: number, nowMs: number, error: string): void {
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'FAILED', sent_at = NULL, lease_started_at = NULL,
          next_attempt_at = ?, last_error = ?
      WHERE id = ? AND status = 'SENDING'
    `).run(nowMs, error.slice(0, 256), deliveryId);
  }

  getActiveMode(): NotificationContentMode | null {
    return this.getActiveChannels('sms.received')[0]?.contentMode ?? null;
  }

  getSettings(_configured: boolean, _signingEnabled: boolean) {
    const channel = this.getChannel('feishu');
    if (!channel) {
      return {
        channel: 'FEISHU' as const,
        configured: false,
        signingEnabled: false,
        enabled: false,
        contentMode: 'REDACTED' as const,
        updatedAt: 0,
        pendingCount: 0,
        retryCount: 0,
        failedCount: 0,
        lastSuccessAt: null,
        lastAttemptAt: null,
      };
    }
    return { ...channel, channel: 'FEISHU' as const };
  }

  updateSettings(enabled: boolean, contentMode: string, nowMs: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO notification_channels(
        channel_id, name, type, enabled, content_mode, event_types_json,
        configured, signing_enabled, updated_at
      ) VALUES ('feishu', 'Feishu', 'FEISHU', 0, 'REDACTED', ?, 1, 0, ?)
    `).run(JSON.stringify(DEFAULT_EVENTS), nowMs);
    this.updateChannel('feishu', enabled, contentMode, DEFAULT_EVENTS, nowMs);
  }
}

function parseEventTypes(value: string): NotificationChannelEventType[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_EVENTS];
    return parsed.filter(
      (item): item is NotificationChannelEventType => (
        typeof item === 'string' && NOTIFICATION_CHANNEL_EVENT_TYPES.has(item)
      ),
    );
  } catch {
    return [...DEFAULT_EVENTS];
  }
}
