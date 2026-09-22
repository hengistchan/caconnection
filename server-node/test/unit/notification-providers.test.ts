import { describe, expect, it, vi } from 'vitest';
import { BarkProvider } from '../../src/notifications/bark-client.js';
import {
  GenericWebhookProvider,
  renderTemplate,
} from '../../src/notifications/generic-webhook-client.js';
import type { GatewayNotificationEvent } from '../../src/notifications/gateway-event.js';
import { NotificationTransportError } from '../../src/notifications/provider.js';

const event: GatewayNotificationEvent = {
  event: {
    id: 'evt_123',
    type: 'sms.received',
    timestamp: 1_700_000_000_000,
  },
  device: {
    id: 'pixel-01',
    name: 'Gateway Phone',
  },
  data: {
    from: '+8613800000000',
    contactName: '张三',
    body: '验证码 "123456"',
  },
  title: 'New SMS · 张三',
  body: '验证码 123456',
  level: 'active',
};

describe('notification providers', () => {
  it('renders path templates and substitutes missing values with an empty string', () => {
    expect(renderTemplate(
      '{{event.type}}|{{device.name}}|{{data.body}}|{{data.missing}}',
      event,
    )).toBe('sms.received|Gateway Phone|验证码 "123456"|');
  });

  it('sends a generic webhook with escaped JSON, query, headers and trace headers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new GenericWebhookProvider(fetchMock as typeof fetch);
    await provider.send({
      id: 'home',
      name: 'Home Webhook',
      type: 'WEBHOOK',
      url: 'https://example.test/hooks',
      method: 'POST',
      headers: { Authorization: 'Bearer {{device.id}}' },
      query: { source: '{{event.type}}' },
      contentType: 'application/json',
      bodyTemplate: '{"message":"{{data.body}}","missing":"{{data.missing}}"}',
      timeoutMs: 5_000,
    }, event);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.test/hooks?source=sms.received');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer pixel-01',
      'x-ca-event-id': 'evt_123',
      'x-ca-event-type': 'sms.received',
    });
    expect(JSON.parse(options.body as string)).toEqual({
      message: '验证码 "123456"',
      missing: '',
    });
  });

  it('retries transient webhook responses but not authentication failures', async () => {
    const channel = {
      id: 'home',
      name: 'Home Webhook',
      type: 'WEBHOOK' as const,
      url: 'https://example.test/hooks',
      method: 'POST' as const,
      headers: {},
      query: {},
      contentType: 'application/json',
      bodyTemplate: '{}',
      timeoutMs: 5_000,
    };
    const providerFor = (status: number) => new GenericWebhookProvider(
      (async () => new Response('', { status })) as typeof fetch,
    );
    await expect(providerFor(503).send(channel, event)).rejects.toMatchObject({
      retryable: true,
    } satisfies Partial<NotificationTransportError>);
    await expect(providerFor(401).send(channel, event)).rejects.toMatchObject({
      retryable: false,
    } satisfies Partial<NotificationTransportError>);
  });

  it('uses Bark JSON POST and enables sustained ringing only for incoming calls', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 200, message: 'success' }),
      { status: 200 },
    ));
    const provider = new BarkProvider(fetchMock as typeof fetch);
    const channel = {
      id: 'iphone',
      name: 'Bark',
      type: 'BARK' as const,
      server: 'https://api.day.app',
      deviceKey: 'device-key',
      group: 'CA Connection',
      sound: 'alarm',
      level: 'active' as const,
      call: true,
    };
    await provider.send(channel, {
      ...event,
      event: { ...event.event, type: 'call.ringing' },
      title: 'Incoming Call',
      body: '张三\n+8613800000000',
      level: 'timeSensitive',
    });

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.day.app/push');
    expect(JSON.parse(options.body as string)).toMatchObject({
      device_key: 'device-key',
      title: 'Incoming Call',
      body: '张三\n+8613800000000',
      group: 'CA Connection',
      sound: 'alarm',
      level: 'timeSensitive',
      call: '1',
    });
  });
});
