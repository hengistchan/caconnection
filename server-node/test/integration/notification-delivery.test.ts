import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  CALL_NOTIFICATION_IDENTITY_WAIT_MS,
  MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
} from '../../src/config/constants.js';
import { parseRuntimeConfig } from '../../src/config/runtime-config.js';
import { initializeDatabase } from '../../src/database/database.js';
import { encryptPayload } from '../../src/crypto/payload-crypto.js';
import { DeviceRepository } from '../../src/repositories/device-repository.js';
import { DeviceStateRepository } from '../../src/repositories/device-state-repository.js';
import { EventRepository } from '../../src/repositories/event-repository.js';
import { NotificationRepository } from '../../src/repositories/notification-repository.js';
import { OutboundRepository } from '../../src/repositories/outbound-repository.js';
import { EventIngestionService } from '../../src/services/event-ingestion-service.js';
import { NotificationDispatcher } from '../../src/services/notification-dispatcher.js';
import type { NotificationTransport } from '../../src/notifications/feishu-client.js';
import { renderFeishuNotification } from '../../src/notifications/renderer.js';

const secret = Buffer.alloc(32, 31);
const deviceId = 'gateway-a';

class RecordingTransport implements NotificationTransport {
  texts: string[] = [];
  failures = 0;

  async sendText(text: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Feishu webhook request failed');
    }
    this.texts.push(text);
  }
}

describe('Feishu notification delivery', () => {
  let dir: string;
  let db: DatabaseSync;
  let deviceRepo: DeviceRepository;
  let notificationRepo: NotificationRepository;
  let ingestion: EventIngestionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-notifications-'));
    db = new DatabaseSync(join(dir, 'gateway.db'), {
      open: true,
      enableForeignKeyConstraints: true,
    });
    initializeDatabase(db);
    deviceRepo = new DeviceRepository(db);
    deviceRepo.add(deviceId, secret.toString('base64'), 'Gateway A', 1_000);
    notificationRepo = new NotificationRepository(db);
    ingestion = new EventIngestionService(
      db,
      deviceRepo,
      new DeviceStateRepository(db),
      new EventRepository(db),
      new OutboundRepository(db),
      notificationRepo,
      30,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('queues in the event transaction without storing plaintext in the outbox', () => {
    notificationRepo.updateSettings(true, 'REDACTED', 1_000);
    const payload = {
      originatingAddress: '+8613812345678',
      body: '您的验证码为 482913',
      partCount: 1,
    };
    const envelope = encryptedEnvelope('INCOMING_SMS', payload);

    expect(ingestion.accept(
      deviceId,
      'notification-event-key',
      'notification-event-nonce',
      envelope,
      payload,
      2_000,
    )).toBe(true);

    const outbox = db.prepare('SELECT * FROM notification_outbox').get() as Record<string, unknown>;
    expect(outbox.event_id).toBe(1);
    expect(outbox.content_mode).toBe('REDACTED');
    expect(JSON.stringify(outbox)).not.toContain('482913');
    expect(JSON.stringify(outbox)).not.toContain('+8613812345678');
  });

  it('queues only the first ringing state for a call session', () => {
    notificationRepo.updateSettings(true, 'REDACTED', 1_000);
    const states = ['RINGING', 'OFFHOOK', 'IDLE'];
    for (const [index, state] of states.entries()) {
      const payload = {
        sessionId: 'call-session-1',
        state,
        observedAt: 2_000 + index * 1_000,
      };
      expect(ingestion.accept(
        deviceId,
        `call-state-${state}`,
        `call-nonce-${state}`,
        encryptedEnvelope('CALL_STATE', payload),
        payload,
        2_000 + index * 1_000,
      )).toBe(true);
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get())
      .toMatchObject({ count: 1 });
    expect(db.prepare('SELECT next_attempt_at FROM notification_outbox').get())
      .toMatchObject({ next_attempt_at: 2_000 + CALL_NOTIFICATION_IDENTITY_WAIT_MS });
  });

  it('does not queue duplicate ringing states for the same call session', () => {
    notificationRepo.updateSettings(true, 'REDACTED', 1_000);
    const payload = {
      sessionId: 'call-session-duplicate',
      state: 'RINGING',
      observedAt: 2_000,
    };

    expect(ingestion.accept(
      deviceId,
      'duplicate-call-state-1',
      'duplicate-call-nonce-1',
      encryptedEnvelope('CALL_STATE', payload),
      payload,
      2_000,
    )).toBe(true);
    expect(ingestion.accept(
      deviceId,
      'duplicate-call-state-2',
      'duplicate-call-nonce-2',
      encryptedEnvelope('CALL_STATE', payload),
      payload,
      2_001,
    )).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get())
      .toMatchObject({ count: 1 });
  });

  it('classifies an unanswered ringing session as a missed call', () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    notificationRepo.updateChannel(
      'feishu',
      true,
      'FULL',
      ['call.ringing', 'call.missed', 'call.ended'],
      1_000,
    );
    const ringing = {
      sessionId: 'missed-call-session',
      state: 'RINGING',
      observedAt: 2_000,
    };
    const idle = {
      sessionId: 'missed-call-session',
      state: 'IDLE',
      observedAt: 4_000,
    };
    ingestion.accept(
      deviceId,
      'missed-call-ringing',
      'missed-call-ringing-nonce',
      encryptedEnvelopeAt('CALL_STATE', ringing, 2_000, 0),
      ringing,
      2_000,
    );
    const identity = {
      callerAddress: '+8613812345678',
      callerDisplayName: 'Example caller',
      observedAt: 2_300,
    };
    ingestion.accept(
      deviceId,
      'missed-call-identity',
      'missed-call-identity-nonce',
      encryptedEnvelopeAt('CALL_IDENTITY', identity, 2_300, 0),
      identity,
      2_300,
    );
    ingestion.accept(
      deviceId,
      'missed-call-idle',
      'missed-call-idle-nonce',
      encryptedEnvelopeAt('CALL_STATE', idle, 4_000, 0),
      idle,
      4_000,
    );

    expect(db.prepare(`
      SELECT notification_event_type
      FROM notification_outbox
      ORDER BY id
    `).all()).toEqual([
      { notification_event_type: 'call.ringing' },
      { notification_event_type: 'call.missed' },
    ]);
    expect(notificationRepo.findCallIdentityEnvelope(3)).not.toBeNull();
  });

  it('renders a redacted incoming call notification', () => {
    const rendered = renderFeishuNotification({
      id: 1,
      eventId: 1,
      kind: 'EVENT',
      attemptCount: 1,
      createdAt: 1_000,
      deviceId,
      eventType: 'CALL_STATE',
      receivedAt: 2_000,
      slotIndex: 0,
      envelopeJson: '{}',
      contentMode: 'REDACTED',
      payload: {
        sessionId: 'call-session-1',
        state: 'RINGING',
        callerAddress: '+8613812345678',
        callerDisplayName: 'Example caller',
      },
    });

    expect(rendered).toContain('CAConnection 来电提醒');
    expect(rendered).toContain('+86*******5678');
    expect(rendered).not.toContain('+8613812345678');
    expect(rendered).toContain('SIM1');
    expect(rendered).toContain('\n设备：');
    expect(rendered).not.toContain('\\n');
  });

  it('waits for and merges the related call identity before delivery', async () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const ringing = {
      sessionId: 'call-session-with-identity',
      state: 'RINGING',
      observedAt: 2_000,
    };
    ingestion.accept(
      deviceId,
      'call-ringing-with-identity',
      'call-ringing-nonce-with-identity',
      encryptedEnvelopeAt('CALL_STATE', ringing, 2_000, 0),
      ringing,
      2_000,
    );
    const identity = {
      callerAddress: '+8613812345678',
      callerDisplayName: 'Example caller',
      observedAt: 2_300,
    };
    ingestion.accept(
      deviceId,
      'call-identity',
      'call-identity-nonce',
      encryptedEnvelopeAt('CALL_IDENTITY', identity, 2_300, 0),
      identity,
      2_300,
    );
    expect(db.prepare('SELECT next_attempt_at FROM notification_outbox').get())
      .toMatchObject({ next_attempt_at: 2_300 });
    const transport = new RecordingTransport();
    const dispatcher = new NotificationDispatcher(
      notificationRepo,
      transport,
      deviceRepo.loadSecrets(),
    );

    expect(await dispatcher.deliverOnce(
      2_299,
    )).toBe(false);
    expect(await dispatcher.deliverOnce(
      2_300,
    )).toBe(true);
    expect(transport.texts).toHaveLength(1);
    expect(transport.texts[0]).toContain('来电号码：+8613812345678');
    expect(transport.texts[0]).toContain('联系人：Example caller');
    expect(transport.texts[0]).toContain('\n设备：');
    expect(transport.texts[0]).not.toContain('\\n');
  });

  it('renders redacted and full messages with distinct privacy boundaries', () => {
    const base = {
      id: 1,
      eventId: 1,
      kind: 'EVENT' as const,
      attemptCount: 1,
      createdAt: 1_000,
      deviceId,
      eventType: 'INCOMING_SMS',
      receivedAt: 2_000,
      slotIndex: 1,
      envelopeJson: '{}',
      payload: {
        originatingAddress: '+8613812345678',
        body: '您的验证码为 482913',
      },
    };
    const redacted = renderFeishuNotification({ ...base, contentMode: 'REDACTED' });
    const full = renderFeishuNotification({ ...base, contentMode: 'FULL' });
    expect(redacted).toContain('+86*******5678');
    expect(redacted).toContain('可能包含验证码');
    expect(redacted).not.toContain('482913');
    expect(full).toContain('+8613812345678');
    expect(full).toContain('482913');
  });

  it('renders timestamps in UTC+8 regardless of host time zone', () => {
    const base = {
      id: 1,
      eventId: 1,
      kind: 'EVENT' as const,
      attemptCount: 1,
      createdAt: 1_000,
      deviceId,
      eventType: 'INCOMING_SMS',
      receivedAt: Date.UTC(2026, 0, 1, 16, 30, 5),
      slotIndex: 0,
      envelopeJson: '{}',
      contentMode: 'REDACTED' as const,
      payload: { originatingAddress: '10086', body: 'hi' },
    };
    const rendered = renderFeishuNotification(base);
    expect(rendered).toContain('2026-01-02 00:30:05');
    expect(rendered).not.toMatch(/UTC|Z\b/);
  });

  it('retries failed delivery and later marks it sent', async () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const payload = { originatingAddress: '10086', body: 'hello' };
    ingestion.accept(
      deviceId,
      'retry-event-key',
      'retry-event-nonce',
      encryptedEnvelope('INCOMING_SMS', payload),
      payload,
      2_000,
    );
    const transport = new RecordingTransport();
    transport.failures = 1;
    const dispatcher = new NotificationDispatcher(
      notificationRepo,
      transport,
      deviceRepo.loadSecrets(),
    );

    expect(await dispatcher.deliverOnce(2_000)).toBe(true);
    expect(db.prepare('SELECT status, attempt_count FROM notification_outbox').get())
      .toMatchObject({ status: 'RETRY', attempt_count: 1 });
    db.prepare("UPDATE notification_outbox SET next_attempt_at = 0").run();
    expect(await dispatcher.deliverOnce(8_000)).toBe(true);
    expect(transport.texts).toHaveLength(1);
    expect(db.prepare('SELECT status, attempt_count FROM notification_outbox').get())
      .toMatchObject({ status: 'SENT', attempt_count: 2 });
  });

  it('moves unreadable encrypted notifications to failed without retrying forever', async () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const payload = { originatingAddress: '10086', body: 'hello' };
    ingestion.accept(
      deviceId,
      'poison-event-key',
      'poison-event-nonce',
      encryptedEnvelope('INCOMING_SMS', payload),
      payload,
      2_000,
    );
    db.prepare('UPDATE events SET envelope_json = ?').run('{invalid');
    const dispatcher = new NotificationDispatcher(
      notificationRepo,
      new RecordingTransport(),
      deviceRepo.loadSecrets(),
    );

    expect(await dispatcher.deliverOnce(2_000)).toBe(true);
    expect(db.prepare(`
      SELECT status, attempt_count, last_error FROM notification_outbox
    `).get()).toMatchObject({
      status: 'FAILED',
      attempt_count: 1,
      last_error: 'invalid encrypted payload',
    });
    expect(notificationRepo.getSettings(true, false).failedCount).toBe(1);
  });

  it('stops retrying after the configured delivery attempt limit', async () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const payload = { originatingAddress: '10086', body: 'hello' };
    ingestion.accept(
      deviceId,
      'exhausted-event-key',
      'exhausted-event-nonce',
      encryptedEnvelope('INCOMING_SMS', payload),
      payload,
      2_000,
    );
    db.prepare(`
      UPDATE notification_outbox
      SET attempt_count = ?, next_attempt_at = 0
    `).run(MAX_NOTIFICATION_DELIVERY_ATTEMPTS - 1);
    const transport = new RecordingTransport();
    transport.failures = 1;
    const dispatcher = new NotificationDispatcher(
      notificationRepo,
      transport,
      deviceRepo.loadSecrets(),
    );

    expect(await dispatcher.deliverOnce(2_000)).toBe(true);
    expect(db.prepare(`
      SELECT status, attempt_count FROM notification_outbox
    `).get()).toMatchObject({
      status: 'FAILED',
      attempt_count: MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
    });
  });

  it('skips removed app-notification events', async () => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const payload = {
      eventType: 'REMOVED',
      sourcePackage: 'com.example.app',
      title: 'Sensitive',
      body: 'Sensitive body',
    };
    ingestion.accept(
      deviceId,
      'removed-event-key',
      'removed-event-nonce',
      encryptedEnvelope('NOTIFICATION', payload),
      payload,
      2_000,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get())
      .toMatchObject({ count: 0 });
  });

  it.each([
    'com.ss.android.lark',
    'com.ss.android.lark.kami',
    'com.ss.android.lark.saxmsa667',
  ])('stores but never forwards Feishu loop-source notifications from %s', sourcePackage => {
    notificationRepo.updateSettings(true, 'FULL', 1_000);
    const payload = {
      eventType: 'POSTED',
      sourcePackage,
      title: 'CAConnection notification',
      body: 'Would otherwise loop back into the Feishu webhook',
    };

    expect(ingestion.accept(
      deviceId,
      `feishu-loop-${sourcePackage}`,
      `feishu-loop-nonce-${sourcePackage}`,
      encryptedEnvelope('NOTIFICATION', payload),
      payload,
      2_000,
    )).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get())
      .toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get())
      .toMatchObject({ count: 0 });
  });

  function encryptedEnvelope(eventType: string, payload: Record<string, unknown>) {
    return encryptedEnvelopeAt(eventType, payload, 1_500, 1);
  }

  function encryptedEnvelopeAt(
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: number,
    slotIndex: number,
  ) {
    return encryptPayload({
      schemaVersion: 1,
      deliveryId: `delivery-${eventType}`,
      sourceEventId: `source-${eventType}`,
      eventType,
      createdAt,
      subscriptionId: 1,
      slotIndex,
      payload,
    }, deviceId, secret);
  }
});

describe('notification settings API', () => {
  let app: FastifyInstance;
  let dir: string;
  const token = 'admin-token';
  const transport = new RecordingTransport();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-notification-api-'));
    transport.texts = [];
    app = await buildApp({
      database: { path: join(dir, 'gateway.db') },
      runtimeConfig: parseRuntimeConfig({
        devices: {
          [deviceId]: { secret_base64: secret.toString('base64') },
        },
        api_clients: {
          admin: {
            token_sha256: createHash('sha256').update(token).digest('hex'),
            scopes: ['notifications:manage'],
          },
        },
        notifications: {
          feishu: {
            webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop',
          },
        },
      }),
      notificationTransport: transport,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates privacy mode and queues a test without exposing the webhook', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const update = await app.inject({
      method: 'PUT',
      url: '/v1/notification-settings',
      headers,
      payload: JSON.stringify({ enabled: true, contentMode: 'FULL' }),
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject({
      configured: true,
      enabled: true,
      contentMode: 'FULL',
    });
    expect(JSON.stringify(update.json())).not.toContain('open.feishu.cn');

    const channels = await app.inject({
      method: 'GET',
      url: '/v1/notification-channels',
      headers,
    });
    expect(channels.statusCode).toBe(200);
    expect(channels.json().channels).toMatchObject([{
      id: 'feishu',
      name: 'Feishu',
      type: 'FEISHU',
      enabled: true,
      contentMode: 'FULL',
    }]);
    expect(JSON.stringify(channels.json())).not.toContain('open.feishu.cn');

    const channelUpdate = await app.inject({
      method: 'PUT',
      url: '/v1/notification-channels/feishu',
      headers,
      payload: JSON.stringify({
        enabled: true,
        contentMode: 'REDACTED',
        eventTypes: ['sms.received', 'call.missed'],
      }),
    });
    expect(channelUpdate.statusCode).toBe(200);
    expect(channelUpdate.json().channel).toMatchObject({
      id: 'feishu',
      contentMode: 'REDACTED',
      eventTypes: ['sms.received', 'call.missed'],
    });

    const test = await app.inject({
      method: 'POST',
      url: '/v1/notification-settings/test',
      headers,
      payload: '{}',
    });
    expect(test.statusCode).toBe(202);
    await waitFor(() => transport.texts.length === 1);
    expect(transport.texts[0]).toContain('飞书推送测试');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for notification');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
