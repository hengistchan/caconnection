import type { RenderableDelivery } from './renderer.js';

export type GatewayNotificationEventType =
  | 'sms.received'
  | 'call.ringing'
  | 'call.missed'
  | 'call.ended'
  | 'notification.received'
  | 'channel.test';

export interface GatewayNotificationEvent {
  event: {
    id: string;
    type: GatewayNotificationEventType;
    timestamp: number;
  };
  device: {
    id: string;
    name: string;
  };
  data: Record<string, string | number | boolean | null>;
  title: string;
  body: string;
  level?: 'active' | 'timeSensitive' | 'passive' | 'critical';
  legacyText?: string;
}

export function normalizeGatewayEvent(delivery: RenderableDelivery): GatewayNotificationEvent | null {
  if (delivery.kind === 'TEST') {
    return {
      event: {
        id: `test_${delivery.id}`,
        type: 'channel.test',
        timestamp: delivery.createdAt,
      },
      device: { id: 'gateway', name: 'CA Connection Gateway' },
      data: { contentMode: delivery.contentMode },
      title: 'CA Connection Test',
      body: 'Notification channel configuration is working.',
    };
  }
  if (!delivery.payload || !delivery.deviceId || !delivery.eventType || delivery.receivedAt === null) {
    throw new Error('notification event is unavailable');
  }
  const payload = delivery.payload;
  const common = {
    event: {
      id: `evt_${delivery.eventId ?? delivery.id}`,
      timestamp: delivery.receivedAt,
    },
    device: { id: delivery.deviceId, name: delivery.deviceId },
  };
  if (delivery.eventType === 'INCOMING_SMS') {
    const from = stringValue(payload.originatingAddress);
    const body = delivery.contentMode === 'FULL' ? stringValue(payload.body) : '';
    return {
      ...common,
      event: { ...common.event, type: 'sms.received' },
      data: {
        from: delivery.contentMode === 'FULL' ? from : maskIdentifier(from),
        contactName: '',
        body,
        slotIndex: delivery.slotIndex,
      },
      title: `New SMS · ${delivery.contentMode === 'FULL' ? (from || 'Unknown') : maskIdentifier(from)}`,
      body: delivery.contentMode === 'FULL'
        ? (body || '(empty)')
        : `Content redacted (${stringValue(payload.body).length} characters)`,
      level: 'active',
    };
  }
  if (delivery.eventType === 'CALL_STATE') {
    const state = stringValue(payload.state);
    if (!['RINGING', 'IDLE'].includes(state)) return null;
    const endedEventType = delivery.notificationEventType === 'call.missed'
      ? 'call.missed'
      : 'call.ended';
    const caller = stringValue(payload.callerAddress);
    const displayName = stringValue(payload.callerDisplayName);
    const visibleCaller = delivery.contentMode === 'FULL' ? caller : maskIdentifier(caller);
    return {
      ...common,
      event: {
        ...common.event,
        type: state === 'RINGING' ? 'call.ringing' : endedEventType,
      },
      data: {
        from: visibleCaller,
        contactName: delivery.contentMode === 'FULL' ? displayName : maskIdentifier(displayName),
        state,
        slotIndex: delivery.slotIndex,
      },
      title: state === 'RINGING'
        ? 'Incoming Call'
        : endedEventType === 'call.missed'
          ? 'Missed Call'
          : 'Call Ended',
      body: [delivery.contentMode === 'FULL' ? displayName : maskIdentifier(displayName), visibleCaller]
        .filter(Boolean)
        .join('\n') || 'Unknown caller',
      level: state === 'RINGING' ? 'timeSensitive' : 'active',
    };
  }
  if (delivery.eventType === 'NOTIFICATION') {
    if (payload.eventType === 'REMOVED') return null;
    const sourcePackage = stringValue(payload.sourcePackage) || 'Unknown';
    const title = stringValue(payload.title);
    const body = stringValue(payload.body);
    return {
      ...common,
      event: { ...common.event, type: 'notification.received' },
      data: {
        sourcePackage,
        title: delivery.contentMode === 'FULL' ? title : '',
        body: delivery.contentMode === 'FULL' ? body : '',
      },
      title: delivery.contentMode === 'FULL' ? (title || 'App Notification') : 'App Notification',
      body: delivery.contentMode === 'FULL'
        ? (body || sourcePackage)
        : `Content redacted · ${sourcePackage}`,
      level: 'active',
    };
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function maskIdentifier(value: string): string {
  if (!value) return 'Unknown';
  if (value.length <= 4) return '*'.repeat(value.length);
  if (value.length <= 8) return `${value.slice(0, 1)}${'*'.repeat(value.length - 2)}${value.slice(-1)}`;
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 7)}${value.slice(-4)}`;
}
