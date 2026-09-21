/** Device status and SIM-line persistence for ingestion side effects. */

import type { DatabaseSync } from 'node:sqlite';
import { extractOtpCandidates } from '../crypto/otp-extraction.js';
import { InvalidEventPayloadError } from '../http/operational-errors.js';

export class DeviceStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Validate and persist a DEVICE_STATE payload. This method intentionally
   * does not start a transaction so ingestion can compose it into one atomic
   * event transaction.
   */
  upsertState(deviceId: string, payload: Record<string, unknown>, nowMs: number): void {
    for (const field of ['defaultSmsRole', 'receiveSmsGranted', 'sendSmsGranted', 'readPhoneStateGranted']) {
      if (typeof payload[field] !== 'boolean') {
        throw new InvalidEventPayloadError(`invalid ${field}`);
      }
    }

    const observedAt = requireNonNegativeInteger(payload.observedAt, 'invalid device state');
    const versionCode = requireNonNegativeInteger(payload.versionCode, 'invalid device state');
    const targetSdk = requireInteger(payload.targetSdk, 1, Number.MAX_SAFE_INTEGER, 'invalid device state');

    for (const field of ['appVersion', 'androidVersion', 'manufacturer', 'model', 'receiveMode']) {
      const value = payload[field];
      if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        throw new InvalidEventPayloadError('invalid device state');
      }
    }
    if (payload.receiveMode !== 'OBSERVER' && payload.receiveMode !== 'DEFAULT_SMS') {
      throw new InvalidEventPayloadError('invalid receiveMode');
    }

    const receiverInvokedAt = optionalNonNegativeInteger(payload.receiverInvokedAt);
    const receiverParseFailureAt = optionalNonNegativeInteger(payload.receiverParseFailureAt);
    const receiverInvokedAction = payload.receiverInvokedAction;
    const receiverParseFailureReason = payload.receiverParseFailureReason;
    if (
      receiverInvokedAction !== undefined
      && receiverInvokedAction !== null
      && receiverInvokedAction !== 'SMS_RECEIVED'
      && receiverInvokedAction !== 'SMS_DELIVER'
    ) {
      throw new InvalidEventPayloadError('invalid receiver diagnostic');
    }
    if (
      receiverParseFailureReason !== undefined
      && receiverParseFailureReason !== null
      && !['NO_MESSAGES', 'PARSER_EXCEPTION', 'PROCESSING_EXCEPTION'].includes(String(receiverParseFailureReason))
    ) {
      throw new InvalidEventPayloadError('invalid receiver diagnostic');
    }
    if (
      (receiverInvokedAt === null) !== (receiverInvokedAction == null)
      || (receiverParseFailureAt === null) !== (receiverParseFailureReason == null)
      || (receiverParseFailureAt !== null && receiverInvokedAt === null)
    ) {
      throw new InvalidEventPayloadError('invalid receiver diagnostic');
    }

    const rawLines = payload.lines;
    if (!Array.isArray(rawLines) || rawLines.length > 4) {
      throw new InvalidEventPayloadError('invalid lines');
    }
    const seenSlots = new Set<number>();
    const lines = rawLines.map(rawLine => {
      if (typeof rawLine !== 'object' || rawLine === null || Array.isArray(rawLine)) {
        throw new InvalidEventPayloadError('invalid line');
      }
      const line = rawLine as Record<string, unknown>;
      const allowedKeys = new Set(['slotIndex', 'subscriptionId', 'carrierName', 'displayName', 'active']);
      if (Object.keys(line).some(key => !allowedKeys.has(key))) {
        throw new InvalidEventPayloadError('invalid line');
      }
      const slotIndex = requireInteger(line.slotIndex, 0, 3, 'invalid line');
      if (seenSlots.has(slotIndex)) throw new InvalidEventPayloadError('invalid line');
      seenSlots.add(slotIndex);
      const subscriptionId = line.subscriptionId;
      if (subscriptionId != null && (!Number.isInteger(subscriptionId) || typeof subscriptionId !== 'number')) {
        throw new InvalidEventPayloadError('invalid line');
      }
      if (typeof line.active !== 'boolean') {
        throw new InvalidEventPayloadError('invalid line');
      }
      for (const field of ['carrierName', 'displayName']) {
        const value = line[field];
        if (value != null && (typeof value !== 'string' || value.length > 128)) {
          throw new InvalidEventPayloadError('invalid line');
        }
      }
      return {
        slotIndex,
        subscriptionId: subscriptionId as number | null | undefined,
        carrierName: line.carrierName as string | null | undefined,
        displayName: line.displayName as string | null | undefined,
        active: line.active,
      };
    });

    this.db.prepare(`
      INSERT INTO device_status(
        device_id, observed_at, app_version, version_code, target_sdk,
        android_version, manufacturer, model, receive_mode, default_sms_role,
        receive_sms_granted, send_sms_granted, read_phone_state_granted,
        last_receiver_invoked_at, last_receiver_invoked_action,
        last_receiver_parse_failure_at, last_receiver_parse_failure_reason,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        observed_at = excluded.observed_at,
        app_version = excluded.app_version,
        version_code = excluded.version_code,
        target_sdk = excluded.target_sdk,
        android_version = excluded.android_version,
        manufacturer = excluded.manufacturer,
        model = excluded.model,
        receive_mode = excluded.receive_mode,
        default_sms_role = excluded.default_sms_role,
        receive_sms_granted = excluded.receive_sms_granted,
        send_sms_granted = excluded.send_sms_granted,
        read_phone_state_granted = excluded.read_phone_state_granted,
        last_receiver_invoked_at = CASE
          WHEN excluded.last_receiver_invoked_at IS NOT NULL
            AND (device_status.last_receiver_invoked_at IS NULL
              OR excluded.last_receiver_invoked_at >= device_status.last_receiver_invoked_at)
          THEN excluded.last_receiver_invoked_at
          ELSE device_status.last_receiver_invoked_at
        END,
        last_receiver_invoked_action = CASE
          WHEN excluded.last_receiver_invoked_at IS NOT NULL
            AND (device_status.last_receiver_invoked_at IS NULL
              OR excluded.last_receiver_invoked_at >= device_status.last_receiver_invoked_at)
          THEN excluded.last_receiver_invoked_action
          ELSE device_status.last_receiver_invoked_action
        END,
        last_receiver_parse_failure_at = CASE
          WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
            AND (device_status.last_receiver_parse_failure_at IS NULL
              OR excluded.last_receiver_parse_failure_at >= device_status.last_receiver_parse_failure_at)
          THEN excluded.last_receiver_parse_failure_at
          ELSE device_status.last_receiver_parse_failure_at
        END,
        last_receiver_parse_failure_reason = CASE
          WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
            AND (device_status.last_receiver_parse_failure_at IS NULL
              OR excluded.last_receiver_parse_failure_at >= device_status.last_receiver_parse_failure_at)
          THEN excluded.last_receiver_parse_failure_reason
          ELSE device_status.last_receiver_parse_failure_reason
        END,
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      observedAt,
      String(payload.appVersion).trim(),
      versionCode,
      targetSdk,
      String(payload.androidVersion).trim(),
      String(payload.manufacturer).trim(),
      String(payload.model).trim(),
      String(payload.receiveMode),
      Number(payload.defaultSmsRole),
      Number(payload.receiveSmsGranted),
      Number(payload.sendSmsGranted),
      Number(payload.readPhoneStateGranted),
      receiverInvokedAt,
      receiverInvokedAction == null ? null : String(receiverInvokedAction),
      receiverParseFailureAt,
      receiverParseFailureReason == null ? null : String(receiverParseFailureReason),
      nowMs,
    );

    this.db.prepare('DELETE FROM device_lines WHERE device_id = ?').run(deviceId);
    for (const line of lines) {
      this.db.prepare(`
        INSERT INTO device_lines(
          device_id, slot_index, subscription_id, carrier_name,
          display_name, is_active, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        line.slotIndex,
        line.subscriptionId ?? null,
        line.carrierName ?? null,
        line.displayName ?? null,
        line.active ? 1 : 0,
        observedAt,
      );
    }
  }

  observeIncomingSms(deviceId: string, payload: Record<string, unknown>, nowMs: number): void {
    const body = typeof payload.body === 'string' ? payload.body : '';
    const candidates = extractOtpCandidates(body);
    const action = payload.action === 'SMS_RECEIVED' || payload.action === 'SMS_DELIVER'
      ? payload.action
      : null;

    this.db.prepare(`
      INSERT INTO device_status(
        device_id, observed_at, updated_at,
        last_incoming_sms_at, last_otp_at, last_ordinary_sms_at,
        last_receiver_action, last_receiver_action_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_incoming_sms_at = excluded.last_incoming_sms_at,
        last_otp_at = COALESCE(excluded.last_otp_at, device_status.last_otp_at),
        last_ordinary_sms_at = COALESCE(excluded.last_ordinary_sms_at, device_status.last_ordinary_sms_at),
        last_receiver_action = COALESCE(excluded.last_receiver_action, device_status.last_receiver_action),
        last_receiver_action_at = COALESCE(excluded.last_receiver_action_at, device_status.last_receiver_action_at),
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      nowMs,
      nowMs,
      nowMs,
      candidates.length > 0 ? nowMs : null,
      candidates.length === 0 ? nowMs : null,
      action,
      action ? nowMs : null,
    );
  }

}

function requireInteger(value: unknown, minimum: number, maximum: number, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new InvalidEventPayloadError(message);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, message: string): number {
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, message);
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, 'invalid receiver diagnostic');
}
