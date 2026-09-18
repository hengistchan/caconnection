import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRepository } from '../repositories/device-repository.js';
import type { DeviceStateRepository } from '../repositories/device-state-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { OutboundRepository } from '../repositories/outbound-repository.js';
import { transaction } from '../database/transaction.js';
import type { ValidatedEnvelope } from '../protocol/envelope.js';

export class EventIngestionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deviceRepo: DeviceRepository,
    private readonly deviceStateRepo: DeviceStateRepository,
    private readonly eventRepo: EventRepository,
    private readonly outboundRepo: OutboundRepository,
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
      const inserted = this.eventRepo.insert(deviceId, idempotencyKey, envelope, nowMs);

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
