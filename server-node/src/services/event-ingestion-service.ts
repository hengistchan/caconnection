import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRepository } from '../repositories/device-repository.js';
import type { DeviceStateRepository } from '../repositories/device-state-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { OutboundRepository } from '../repositories/outbound-repository.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';
import { transaction } from '../database/transaction.js';
import type { ValidatedEnvelope } from '../protocol/envelope.js';

export class EventIngestionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deviceRepo: DeviceRepository,
    private readonly deviceStateRepo: DeviceStateRepository,
    private readonly eventRepo: EventRepository,
    private readonly outboundRepo: OutboundRepository,
    private readonly notificationRepo: NotificationRepository,
    private readonly retentionDays: number,
  ) {}

  accept(
    deviceId: string,
    idempotencyKey: string,
    nonce: string,
    envelope: ValidatedEnvelope,
    decryptedPayload: Record<string, unknown>,
    nowMs: number,
  ): boolean {
    return transaction(this.db, () => {
      this.eventRepo.recordNonce(deviceId, nonce, nowMs);
      const insertion = this.eventRepo.insertWithId(
        deviceId,
        idempotencyKey,
        envelope,
        nowMs,
      );
      const inserted = insertion.inserted;

      const notificationMode = this.notificationRepo.getActiveMode();
      if (
        inserted
        && insertion.eventId !== null
        && notificationMode !== null
        && shouldEnqueueNotification(envelope.eventType, decryptedPayload)
      ) {
        this.notificationRepo.enqueueEvent(
          insertion.eventId,
          notificationMode,
          nowMs,
        );
      }

      if (envelope.eventType === 'OUTBOUND_SMS_STATUS') {
        if (!this.outboundRepo.updateStatus(deviceId, decryptedPayload, nowMs)) {
          throw new Error('unknown outbound command');
        }
      } else if (envelope.eventType === 'DEVICE_STATE') {
        this.deviceStateRepo.upsertState(deviceId, decryptedPayload, nowMs);
      } else if (envelope.eventType === 'INCOMING_SMS') {
        this.deviceStateRepo.observeIncomingSms(deviceId, decryptedPayload, nowMs);
      }

      this.deviceRepo.touchDevice(deviceId, nowMs);
      this.eventRepo.pruneInTransaction(this.retentionDays, nowMs);
      return inserted;
    });
  }
}

function shouldEnqueueNotification(
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  if (eventType === 'INCOMING_SMS') return true;
  return eventType === 'NOTIFICATION' && payload.eventType !== 'REMOVED';
}
