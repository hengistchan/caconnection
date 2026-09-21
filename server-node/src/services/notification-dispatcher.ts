import { decryptPayload } from '../crypto/payload-crypto.js';
import { MAX_NOTIFICATION_DELIVERY_ATTEMPTS } from '../config/constants.js';
import {
  NotificationTransportError,
  type NotificationTransport,
} from '../notifications/feishu-client.js';
import {
  renderFeishuNotification,
  type RenderableDelivery,
} from '../notifications/renderer.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';

const SAFE_DELIVERY_ERRORS = new Set([
  'device secret unavailable',
  'invalid encrypted payload',
  'notification event is unavailable',
  'Feishu webhook request failed',
  'Feishu webhook response is too large',
  'Feishu webhook returned invalid JSON',
  'Feishu webhook rejected the message',
]);

export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private processing: Promise<void> | undefined;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly transport: NotificationTransport,
    private readonly deviceSecrets: Map<string, Buffer>,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  wake(): void {
    if (this.stopped || this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.processing;
  }

  async deliverOnce(nowMs = Date.now()): Promise<boolean> {
    const delivery = this.repository.claimDue(nowMs);
    if (!delivery) return false;
    try {
      const renderable: RenderableDelivery = { ...delivery };
      if (delivery.kind === 'EVENT') {
        if (!delivery.deviceId || !delivery.envelopeJson) {
          throw new Error('notification event is unavailable');
        }
        const secret = this.deviceSecrets.get(delivery.deviceId);
        if (!secret) throw new Error('device secret unavailable');
        const envelope = decryptDeliveryEnvelope(
          delivery.envelopeJson,
          delivery.deviceId,
          secret,
        );
        let payload = envelope.payload as Record<string, unknown>;
        if (delivery.eventType === 'CALL_STATE' && delivery.eventId !== null) {
          const identityEnvelopeJson = this.repository.findCallIdentityEnvelope(
            delivery.eventId,
          );
          if (identityEnvelopeJson) {
            const identityEnvelope = decryptDeliveryEnvelope(
              identityEnvelopeJson,
              delivery.deviceId,
              secret,
            );
            payload = {
              ...payload,
              ...(identityEnvelope.payload as Record<string, unknown>),
            };
          }
        }
        renderable.payload = payload;
      }
      const text = renderFeishuNotification(renderable);
      if (text === null) {
        this.repository.finish(delivery.id, Date.now(), true);
      } else {
        await this.transport.sendText(text);
        this.repository.finish(delivery.id, Date.now());
      }
    } catch (error) {
      const message = error instanceof Error && SAFE_DELIVERY_ERRORS.has(error.message)
        ? error.message
        : 'notification delivery failed';
      const retryable = error instanceof NotificationTransportError
        ? error.retryable
        : ![
          'device secret unavailable',
          'invalid encrypted payload',
          'notification event is unavailable',
        ].includes(message);
      if (
        !retryable
        || delivery.attemptCount >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS
      ) {
        this.repository.fail(delivery.id, Date.now(), message);
      } else {
        this.repository.retry(
          delivery.id,
          delivery.attemptCount,
          Date.now(),
          message,
        );
      }
    }
    return true;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.processing = this.process()
        .finally(() => {
          this.processing = undefined;
          if (!this.stopped) this.schedule(1_000);
        });
    }, delayMs);
    this.timer.unref();
  }

  private async process(): Promise<void> {
    for (let index = 0; index < 20 && !this.stopped; index += 1) {
      if (!await this.deliverOnce()) return;
    }
  }
}

function decryptDeliveryEnvelope(
  envelopeJson: string,
  deviceId: string,
  secret: Buffer,
): ReturnType<typeof decryptPayload> {
  try {
    return decryptPayload(JSON.parse(envelopeJson), deviceId, secret);
  } catch {
    throw new Error('invalid encrypted payload');
  }
}
