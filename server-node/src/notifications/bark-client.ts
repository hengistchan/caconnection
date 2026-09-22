import type { NotificationChannelConfig } from '../config/runtime-config.js';
import type { GatewayNotificationEvent } from './gateway-event.js';
import {
  NotificationTransportError,
  type NotificationProvider,
} from './provider.js';

export class BarkProvider implements NotificationProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(channel: NotificationChannelConfig, event: GatewayNotificationEvent): Promise<void> {
    if (channel.type !== 'BARK') throw new Error('invalid Bark channel');
    const payload: Record<string, unknown> = {
      device_key: channel.deviceKey,
      title: event.title,
      body: event.body,
      group: channel.group,
      level: event.level ?? channel.level,
    };
    if (channel.sound) payload.sound = channel.sound;
    if (channel.call && event.event.type === 'call.ringing') payload.call = '1';

    let response: Response;
    try {
      response = await this.fetchImpl(`${channel.server}/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'CAConnection-Gateway/1.0',
          'x-ca-event-id': event.event.id,
          'x-ca-event-type': event.event.type,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new NotificationTransportError('Bark request failed', true);
    }
    if (!response.ok) {
      throw new NotificationTransportError(
        'Bark request failed',
        [408, 425, 429, 500, 502, 503, 504].includes(response.status),
      );
    }
    const result = await safeJson(response);
    if (
      result
      && typeof result === 'object'
      && !Array.isArray(result)
      && 'code' in result
      && (result as { code?: unknown }).code !== 200
    ) {
      throw new NotificationTransportError('Bark rejected the message', false);
    }
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (Buffer.byteLength(text, 'utf-8') > 65_536) {
    throw new NotificationTransportError('Bark response is too large', false);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
