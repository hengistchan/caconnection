import type { NotificationChannelConfig } from '../config/runtime-config.js';
import type { GatewayNotificationEvent } from './gateway-event.js';

export interface NotificationProvider {
  send(channel: NotificationChannelConfig, event: GatewayNotificationEvent): Promise<void>;
}

export class NotificationTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NotificationTransportError';
  }
}

export class NotificationProviderRegistry {
  private readonly providers = new Map<NotificationChannelConfig['type'], NotificationProvider>();

  register(type: NotificationChannelConfig['type'], provider: NotificationProvider): void {
    this.providers.set(type, provider);
  }

  get(type: NotificationChannelConfig['type']): NotificationProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error('notification provider unavailable');
    return provider;
  }
}
