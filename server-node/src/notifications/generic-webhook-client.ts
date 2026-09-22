import type {
  GenericWebhookChannelConfig,
  NotificationChannelConfig,
} from '../config/runtime-config.js';
import type { GatewayNotificationEvent } from './gateway-event.js';
import {
  NotificationTransportError,
  type NotificationProvider,
} from './provider.js';

const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export class GenericWebhookProvider implements NotificationProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(channel: NotificationChannelConfig, event: GatewayNotificationEvent): Promise<void> {
    if (channel.type !== 'WEBHOOK') throw new Error('invalid Webhook channel');
    const url = buildUrl(channel, event);
    const headers: Record<string, string> = {
      'content-type': channel.contentType,
      'user-agent': 'CAConnection-Gateway/1.0',
      'x-ca-event-id': event.event.id,
      'x-ca-event-type': event.event.type,
    };
    for (const [key, value] of Object.entries(channel.headers)) {
      headers[key] = renderTemplate(value, event);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: channel.method,
        headers,
        body: renderTemplate(
          channel.bodyTemplate,
          event,
          channel.contentType.toLowerCase().includes('json'),
        ),
        redirect: 'error',
        signal: AbortSignal.timeout(channel.timeoutMs),
      });
    } catch {
      throw new NotificationTransportError('Webhook request failed', true);
    }
    if (!response.ok) {
      throw new NotificationTransportError(
        'Webhook request failed',
        isRetryableStatus(response.status),
      );
    }
  }
}

export function renderTemplate(
  template: string,
  event: GatewayNotificationEvent,
  jsonEscape = false,
): string {
  return template.replace(TEMPLATE_PATTERN, (_match, path: string) => {
    const value = resolvePath(event, path);
    if (value === undefined || value === null) return '';
    if (jsonEscape && typeof value === 'string') {
      return JSON.stringify(value).slice(1, -1);
    }
    return String(value);
  });
}

function buildUrl(
  channel: GenericWebhookChannelConfig,
  event: GatewayNotificationEvent,
): string {
  const url = new URL(channel.url);
  for (const [key, value] of Object.entries(channel.query)) {
    url.searchParams.set(key, renderTemplate(value, event));
  }
  return url.toString();
}

function resolvePath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}
