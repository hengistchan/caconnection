import { createHmac } from 'node:crypto';
import type {
  FeishuChannelConfig,
  FeishuConfig,
  NotificationChannelConfig,
} from '../config/runtime-config.js';
import type { GatewayNotificationEvent } from './gateway-event.js';
import {
  NotificationTransportError,
  type NotificationProvider,
} from './provider.js';

export interface NotificationTransport {
  sendText(text: string): Promise<void>;
}

export function createFeishuSignature(secret: string, timestampSeconds: number): string {
  const key = `${timestampSeconds}\n${secret}`;
  return createHmac('sha256', key).update('').digest('base64');
}

export class FeishuWebhookClient implements NotificationTransport, NotificationProvider {
  constructor(
    private readonly config: FeishuConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(channel: NotificationChannelConfig, event: GatewayNotificationEvent): Promise<void> {
    if (channel.type !== 'FEISHU') throw new Error('invalid Feishu channel');
    const client = sameFeishuConfig(channel, this.config)
      ? this
      : new FeishuWebhookClient(channel, this.fetchImpl);
    await client.sendText(event.legacyText ?? [event.title, event.body].filter(Boolean).join('\n'));
  }

  async sendText(text: string): Promise<void> {
    const payload: Record<string, unknown> = {
      msg_type: 'text',
      content: { text },
    };
    if (this.config.signingSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      payload.timestamp = String(timestamp);
      payload.sign = createFeishuSignature(this.config.signingSecret, timestamp);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'CAConnection-Gateway/1.0',
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new NotificationTransportError(
        'Feishu webhook request failed',
        true,
      );
    }
    if (!response.ok) {
      throw new NotificationTransportError(
        'Feishu webhook request failed',
        response.status === 408
          || response.status === 425
          || response.status === 429
          || response.status >= 500,
      );
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > 65_536) {
      throw new NotificationTransportError(
        'Feishu webhook response is too large',
        false,
      );
    }
    let result: unknown;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf-8') > 65_536) {
        throw new Error('response too large');
      }
      result = JSON.parse(text);
    } catch {
      throw new NotificationTransportError(
        'Feishu webhook returned invalid JSON',
        false,
      );
    }
    if (!isRecord(result)) {
      throw new NotificationTransportError(
        'Feishu webhook returned invalid JSON',
        false,
      );
    }
    const code = result.code ?? result.StatusCode;
    if (code !== 0) {
      throw new NotificationTransportError(
        'Feishu webhook rejected the message',
        false,
      );
    }
  }
}

function sameFeishuConfig(
  channel: FeishuChannelConfig,
  config: FeishuConfig,
): boolean {
  return channel.webhookUrl === config.webhookUrl
    && channel.signingSecret === config.signingSecret;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
