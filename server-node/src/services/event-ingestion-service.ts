import type { DatabaseSync } from 'node:sqlite';
import { CALL_NOTIFICATION_IDENTITY_WAIT_MS } from '../config/constants.js';
import type { DeviceRepository } from '../repositories/device-repository.js';
import type { DeviceStateRepository } from '../repositories/device-state-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { OutboundRepository } from '../repositories/outbound-repository.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';
import { transaction } from '../database/transaction.js';
import type { ValidatedEnvelope } from '../protocol/envelope.js';
import { InvalidEventPayloadError } from '../http/operational-errors.js';

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
      const isCallRinging = envelope.eventType === 'CALL_STATE'
        && decryptedPayload.state === 'RINGING'
        && typeof decryptedPayload.sessionId === 'string';
      const insertion = this.eventRepo.insertWithId(
        deviceId,
        idempotencyKey,
        envelope,
        nowMs,
      );
      const inserted = insertion.inserted;
      const callSessionId = envelope.eventType === 'CALL_STATE'
        && typeof decryptedPayload.sessionId === 'string'
        ? decryptedPayload.sessionId
        : null;

      if (
        inserted
        && insertion.eventId !== null
        && envelope.eventType === 'CALL_IDENTITY'
      ) {
        this.notificationRepo.expediteRelatedCallNotification(
          insertion.eventId,
          nowMs,
        );
      }

      if (inserted && callSessionId && decryptedPayload.state === 'OFFHOOK') {
        this.eventRepo.markCallSessionAnswered(deviceId, callSessionId, nowMs);
      }
      const claimedCallEndType = inserted
        && callSessionId
        && decryptedPayload.state === 'IDLE'
        && insertion.eventId !== null
        ? this.eventRepo.claimCallSessionEnded(
          deviceId,
          callSessionId,
          insertion.eventId,
          nowMs,
        )
        : null;
      if (claimedCallEndType) {
        decryptedPayload = {
          ...decryptedPayload,
          notificationEventType: claimedCallEndType,
        };
      }
      const notificationEventType = claimedCallEndType ?? toNotificationEventType(
        envelope.eventType,
        decryptedPayload,
      );
      const notificationChannels = notificationEventType === null
        ? []
        : this.notificationRepo.getActiveChannels(
          notificationEventType,
          isFeishuWebhookLoopSourcePayload(envelope.eventType, decryptedPayload)
            ? ['FEISHU']
            : [],
        );
      const shouldNotifyCallRinging = isCallRinging
        && insertion.eventId !== null
        && this.eventRepo.claimCallSessionRinging(
          deviceId,
          decryptedPayload.sessionId as string,
          insertion.eventId,
          nowMs,
        );
      if (
        inserted
        && insertion.eventId !== null
        && notificationEventType !== null
        && notificationChannels.length > 0
        && (!isCallRinging || shouldNotifyCallRinging)
      ) {
        this.notificationRepo.enqueueEvent(
          insertion.eventId,
          notificationChannels,
          notificationEventType,
          nowMs,
          isCallRinging
            && this.notificationRepo.findCallIdentityEnvelope(insertion.eventId) === null
            ? nowMs + CALL_NOTIFICATION_IDENTITY_WAIT_MS
            : nowMs,
        );
      }

      if (envelope.eventType === 'OUTBOUND_SMS_STATUS') {
        if (!this.outboundRepo.updateStatus(deviceId, decryptedPayload, nowMs)) {
          throw new InvalidEventPayloadError('unknown outbound command');
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

function toNotificationEventType(
  eventType: string,
  payload: Record<string, unknown>,
): 'sms.received' | 'call.ringing' | 'notification.received' | null {
  if (eventType === 'INCOMING_SMS') return 'sms.received';
  if (eventType === 'NOTIFICATION') {
    if (payload.eventType === 'REMOVED') return null;
    return 'notification.received';
  }
  if (eventType === 'CALL_STATE' && payload.state === 'RINGING') return 'call.ringing';
  return null;
}

function isFeishuWebhookLoopSourcePayload(
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  if (eventType !== 'NOTIFICATION') return false;
  const sourcePackage = typeof payload.sourcePackage === 'string'
    ? payload.sourcePackage
    : typeof payload.packageName === 'string'
      ? payload.packageName
      : null;
  return sourcePackage !== null && isFeishuWebhookLoopSource(sourcePackage);
}

function isFeishuWebhookLoopSource(packageName: string): boolean {
  return packageName === 'com.ss.android.lark'
    || packageName.startsWith('com.ss.android.lark.');
}
