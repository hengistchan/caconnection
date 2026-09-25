import { decryptPayload } from '../crypto/payload-crypto.js';
import { MAX_NOTIFICATION_DELIVERY_ATTEMPTS } from '../config/constants.js';
import type { NotificationChannelConfig } from '../config/runtime-config.js';
import { normalizeGatewayEvent } from '../notifications/gateway-event.js';
import {
  NotificationProviderRegistry,
  NotificationTransportError,
} from '../notifications/provider.js';
import type { NotificationTransport } from '../notifications/feishu-client.js';
import {
  renderFeishuNotification,
  type RenderableDelivery,
} from '../notifications/renderer.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';

const NON_RETRYABLE_LOCAL_ERRORS = new Set([
  'device secret unavailable',
  'invalid encrypted payload',
  'notification event is unavailable',
  'notification channel unavailable',
  'notification provider unavailable',
]);

export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private processing: Promise<void> | undefined;

  private readonly providers: NotificationProviderRegistry;
  private readonly channels: Map<string, NotificationChannelConfig>;
  private readonly deviceSecrets: Map<string, Buffer>;

  constructor(
    private readonly repository: NotificationRepository,
    providersOrTransport: NotificationProviderRegistry | NotificationTransport,
    channelsOrSecrets: Map<string, NotificationChannelConfig> | Map<string, Buffer>,
    deviceSecrets?: Map<string, Buffer>,
  ) {
    if ('sendText' in providersOrTransport) {
      this.providers = new NotificationProviderRegistry();
      this.providers.register('FEISHU', {
        send: async (_channel, event) => {
          await providersOrTransport.sendText(
            event.legacyText ?? [event.title, event.body].join('\n'),
          );
        },
      });
      this.channels = new Map([[
        'feishu',
        {
          id: 'feishu',
          name: 'Feishu',
          type: 'FEISHU',
          webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/compatibility',
          signingSecret: null,
        },
      ]]);
      this.deviceSecrets = channelsOrSecrets as Map<string, Buffer>;
    } else {
      this.providers = providersOrTransport;
      this.channels = channelsOrSecrets as Map<string, NotificationChannelConfig>;
      this.deviceSecrets = deviceSecrets ?? new Map();
    }
  }

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
    // claimDue may throw (SQLITE_FULL / SQLITE_BUSY past busy_timeout). The
    // caller (process()) converts that into a backed-off reschedule — it must
    // never become an unhandled rejection, which terminates the whole gateway
    // under Node's default --unhandled-rejections=throw.
    const delivery = this.repository.claimDue(nowMs);
    if (!delivery) return false;
    try {
      const channel = this.channels.get(delivery.channelId ?? 'feishu');
      if (!channel) throw new Error('notification channel unavailable');
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
        if (
          delivery.eventType === 'CALL_STATE'
          && delivery.eventId !== null
          && (payload.state === 'RINGING' || payload.state === 'IDLE')
        ) {
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
      const event = normalizeGatewayEvent(renderable);
      if (event === null) {
        this.finishQuietly(delivery.id, true);
      } else {
        event.legacyText = renderFeishuNotification(renderable) ?? undefined;
        await this.providers.get(channel.type).send(channel, event);
        // The send succeeded. A finish() failure here must NOT be classified
        // as a delivery failure — retry() would requeue and duplicate the
        // notification. Leave the row leased; lease recovery re-delivers only
        // as the documented at-least-once fallback.
        this.finishQuietly(delivery.id, false);
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      const retryable = error instanceof NotificationTransportError
        ? error.retryable
        : !NON_RETRYABLE_LOCAL_ERRORS.has(message);
      try {
        if (!retryable || delivery.attemptCount >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS) {
          this.repository.fail(delivery.id, Date.now(), message);
        } else {
          this.repository.retry(delivery.id, delivery.attemptCount, Date.now(), message);
        }
      } catch (bookkeepingError) {
        // Keep the row leased instead of crashing over bookkeeping.
        console.error(
          'notification delivery bookkeeping failed',
          safeErrorMessage(bookkeepingError),
        );
      }
    }
    return true;
  }

  /**
   * Record the delivery outcome without letting a bookkeeping error escape.
   * The row keeps its lease if the write fails, so it is retried later rather
   * than requeued as a failed send.
   */
  private finishQuietly(deliveryId: number, skipNotify: boolean): void {
    try {
      this.repository.finish(deliveryId, Date.now(), skipNotify);
    } catch (error) {
      console.error(
        'notification delivery finish failed',
        safeErrorMessage(error),
      );
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.processing = this.process()
        .catch((error: unknown) => {
          // Defense in depth: nothing above should reject anymore, but an
          // unhandled rejection here would take the whole gateway down.
          console.error(
            'notification dispatcher pass failed',
            safeErrorMessage(error),
          );
        })
        .finally(() => {
          this.processing = undefined;
          if (!this.stopped) this.schedule(1_000);
        });
    }, delayMs);
    this.timer.unref();
  }

  private async process(): Promise<void> {
    for (let index = 0; index < 20 && !this.stopped; index += 1) {
      try {
        if (!await this.deliverOnce()) return;
      } catch (error) {
        // Repository errors (SQLITE_FULL / SQLITE_BUSY) abort this pass; the
        // 1s reschedule retries with natural backoff instead of crashing.
        console.error(
          'notification dispatcher delivery pass failed',
          safeErrorMessage(error),
        );
        return;
      }
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

function safeErrorMessage(error: unknown): string {
  if (error instanceof NotificationTransportError) return error.message.slice(0, 128);
  if (error instanceof Error && NON_RETRYABLE_LOCAL_ERRORS.has(error.message)) {
    return error.message;
  }
  return 'notification delivery failed';
}
