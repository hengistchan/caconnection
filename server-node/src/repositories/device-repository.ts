/**
 * Device repository.
 *
 * Manages devices, device_status, and device_lines tables.
 * Matches the Python gateway's GatewayStore device methods.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { queryAll, queryOne } from '../database/helpers.js';
import { encryptPayload, decryptPayload } from '../crypto/payload-crypto.js';
import {
  DEVICE_ONLINE_WINDOW_MS,
  DEVICE_STALE_WINDOW_MS,
  NONCE_RETENTION_MS,
} from '../config/constants.js';

export interface DeviceRow {
  device_id: string;
  secret_base64: string;
  description: string;
  created_at: number;
  last_seen_at: number | null;
  retired_at: number | null;
}

export interface DeviceStatusRow {
  device_id: string;
  observed_at: number;
  app_version: string | null;
  version_code: number | null;
  target_sdk: number | null;
  android_version: string | null;
  manufacturer: string | null;
  model: string | null;
  receive_mode: string | null;
  default_sms_role: number | null;
  receive_sms_granted: number | null;
  send_sms_granted: number | null;
  read_phone_state_granted: number | null;
  last_incoming_sms_at: number | null;
  last_otp_at: number | null;
  last_ordinary_sms_at: number | null;
  last_receiver_action: string | null;
  last_receiver_action_at: number | null;
  last_receiver_invoked_at: number | null;
  last_receiver_invoked_action: string | null;
  last_receiver_parse_failure_at: number | null;
  last_receiver_parse_failure_reason: string | null;
  updated_at: number;
}

export interface DeviceLineRow {
  device_id: string;
  slot_index: number;
  subscription_id: number | null;
  carrier_name: string | null;
  display_name: string | null;
  is_active: number;
  observed_at: number;
}

export interface DeviceDetail {
  deviceId: string;
  description: string;
  createdAt: number;
  lastSeenAt: number | null;
  retiredAt: number | null;
  health: string;
  status: {
    observedAt: number | null;
    appVersion: string | null;
    versionCode: number | null;
    targetSdk: number | null;
    androidVersion: string | null;
    manufacturer: string | null;
    model: string | null;
    receiveMode: string | null;
    defaultSmsRole: boolean | null;
    permissions: {
      receiveSms: boolean | null;
      sendSms: boolean | null;
      readPhoneState: boolean | null;
    };
    lastIncomingSmsAt: number | null;
    lastOtpAt: number | null;
    lastOrdinarySmsAt: number | null;
    lastReceiverAction: string | null;
    lastReceiverActionAt: number | null;
    lastReceiverInvokedAt: number | null;
    lastReceiverInvokedAction: string | null;
    lastReceiverParseFailureAt: number | null;
    lastReceiverParseFailureReason: string | null;
    lines: Array<{
      slotIndex: number;
      subscriptionId: number | null;
      carrierName: string | null;
      displayName: string | null;
      active: boolean;
      observedAt: number;
    }>;
  };
}

export class DeviceRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Check if a device is active (exists and not retired).
   */
  isActive(deviceId: string): boolean {
    const row = queryOne<DeviceRow>(this.db, 'SELECT retired_at FROM devices WHERE device_id = ?', deviceId);
    return row === undefined || row.retired_at === null;
  }

  /**
   * Record a request nonce for replay protection.
   */
  recordNonce(deviceId: string, nonce: string, nowMs: number): void {
    this.db.prepare('DELETE FROM request_nonces WHERE seen_at < ?').run(nowMs - NONCE_RETENTION_MS);
    try {
      this.db.prepare('INSERT INTO request_nonces(device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, nonce, nowMs);
    } catch (error: any) {
      if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.errcode === 1555) {
        throw new Error('replayed nonce');
      }
      throw error;
    }
  }

  /**
   * Update device last_seen_at timestamp.
   */
  touchDevice(deviceId: string, nowMs: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(nowMs, deviceId);
  }

  /**
   * Load all device secrets.
   */
  loadSecrets(): Map<string, Buffer> {
    const rows = queryAll<DeviceRow>(this.db, 'SELECT device_id, secret_base64 FROM devices');
    const result = new Map<string, Buffer>();
    for (const row of rows) {
      try {
        const secret = Buffer.from(row.secret_base64, 'base64');
        if (secret.length >= 32) {
          result.set(row.device_id, secret);
        }
      } catch {
        continue;
      }
    }
    return result;
  }

  /**
   * Get all devices with status and lines.
   */
  getAll(): DeviceDetail[] {
    const nowMs = Date.now();
    const rows = queryAll<any>(this.db, `
      SELECT d.device_id, d.description, d.created_at, d.last_seen_at, d.retired_at,
             s.observed_at, s.app_version, s.version_code, s.target_sdk, s.android_version,
             s.manufacturer, s.model, s.receive_mode, s.default_sms_role,
             s.receive_sms_granted, s.send_sms_granted, s.read_phone_state_granted,
             s.last_incoming_sms_at, s.last_otp_at, s.last_ordinary_sms_at,
             s.last_receiver_action, s.last_receiver_action_at,
             s.last_receiver_invoked_at, s.last_receiver_invoked_action,
             s.last_receiver_parse_failure_at, s.last_receiver_parse_failure_reason
      FROM devices d
      LEFT JOIN device_status s ON s.device_id = d.device_id
      ORDER BY d.device_id
    `);

    const lineRows = queryAll<DeviceLineRow>(this.db, `
      SELECT device_id, slot_index, subscription_id, carrier_name, display_name, is_active, observed_at
      FROM device_lines
      ORDER BY device_id, slot_index
    `);

    const linesByDevice = new Map<string, DeviceLineRow[]>();
    for (const line of lineRows) {
      const lines = linesByDevice.get(line.device_id) || [];
      lines.push(line);
      linesByDevice.set(line.device_id, lines);
    }

    return rows.map(row => this.toDeviceDetail(row, linesByDevice.get(row.device_id) || [], nowMs));
  }

  /**
   * Get a single device by ID.
   */
  getById(deviceId: string): DeviceDetail | null {
    const devices = this.getAll();
    return devices.find(d => d.deviceId === deviceId) || null;
  }

  /**
   * Add a new device.
   */
  add(deviceId: string, secretBase64: string, description: string, nowMs: number): DeviceDetail {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      throw new Error('Invalid device ID format');
    }

    const secret = Buffer.from(secretBase64, 'base64');
    if (secret.length < 32) {
      throw new Error('Secret must be at least 32 bytes');
    }

    try {
      this.db.prepare('INSERT INTO devices(device_id, secret_base64, description, created_at) VALUES (?, ?, ?, ?)').run(deviceId, secretBase64, description, nowMs);
    } catch (error: any) {
      if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.errcode === 1555) {
        throw new Error(`Device '${deviceId}' already exists`);
      }
      throw error;
    }

    return this.getById(deviceId)!;
  }

  /**
   * Update device description and/or secret.
   *
   * When secretBase64 changes, all existing event and outbound_command
   * payloads are re-encrypted in the same transaction so historical
   * messages remain readable with the new secret.
   */
  update(deviceId: string, description?: string, secretBase64?: string): DeviceDetail | null {
    const existing = queryOne<DeviceRow>(this.db, 'SELECT secret_base64 FROM devices WHERE device_id = ?', deviceId);
    if (!existing) return null;

    return transaction(this.db, () => {
      if (description !== undefined) {
        this.db.prepare('UPDATE devices SET description = ? WHERE device_id = ?').run(description, deviceId);
      }

      if (secretBase64 !== undefined) {
        const newSecret = Buffer.from(secretBase64, 'base64');
        if (newSecret.length < 32) {
          throw new Error('Secret must be at least 32 bytes');
        }

        const oldSecret = Buffer.from(existing.secret_base64, 'base64');

        if (!oldSecret.equals(newSecret)) {
          // Re-encrypt events
          const eventRows = queryAll<{ id: number; envelope_json: string }>(
            this.db,
            'SELECT id, envelope_json FROM events WHERE device_id = ?',
            deviceId,
          );
          for (const row of eventRows) {
            const envelope = decryptPayload(JSON.parse(row.envelope_json), deviceId, oldSecret);
            // Reset to schemaVersion 1 so encryptPayload will re-encrypt
            (envelope as Record<string, unknown>).schemaVersion = 1;
            const reencrypted = encryptPayload(envelope, deviceId, newSecret);
            this.db.prepare('UPDATE events SET envelope_json = ? WHERE id = ?').run(
              JSON.stringify(reencrypted),
              row.id,
            );
          }

          // Re-encrypt outbound commands
          const commandRows = queryAll<{ id: number; envelope_json: string }>(
            this.db,
            'SELECT id, envelope_json FROM outbound_commands WHERE device_id = ?',
            deviceId,
          );
          for (const row of commandRows) {
            const envelope = decryptPayload(JSON.parse(row.envelope_json), deviceId, oldSecret);
            (envelope as Record<string, unknown>).schemaVersion = 1;
            const reencrypted = encryptPayload(envelope, deviceId, newSecret);
            this.db.prepare('UPDATE outbound_commands SET envelope_json = ? WHERE id = ?').run(
              JSON.stringify(reencrypted),
              row.id,
            );
          }
        }

        this.db.prepare('UPDATE devices SET secret_base64 = ? WHERE device_id = ?').run(secretBase64, deviceId);
      }

      return this.getById(deviceId);
    });
  }

  /**
   * Retire a device.
   */
  retire(deviceId: string, nowMs: number): boolean {
    const result = this.db.prepare('UPDATE devices SET retired_at = COALESCE(retired_at, ?) WHERE device_id = ?').run(nowMs, deviceId);
    if (result.changes === 0) return false;

    this.db.prepare('UPDATE pairing_sessions SET consumed_at = COALESCE(consumed_at, ?) WHERE device_id = ?').run(nowMs, deviceId);
    this.db.prepare("UPDATE outbound_commands SET status = 'EXPIRED', updated_at = ? WHERE device_id = ? AND status IN ('QUEUED', 'CLAIMED')").run(nowMs, deviceId);

    return true;
  }

  /**
   * Restore a retired device.
   */
  restore(deviceId: string): boolean {
    const result = this.db.prepare('UPDATE devices SET retired_at = NULL WHERE device_id = ?').run(deviceId);
    return result.changes > 0;
  }

  /**
   * Purge a device and all associated data.
   */
  purge(deviceId: string): boolean {
    return transaction(this.db, () => {
      const existing = queryOne(this.db, 'SELECT 1 FROM devices WHERE device_id = ?', deviceId);
      if (!existing) return false;

      const eventIds = queryAll<{ id: number }>(this.db, 'SELECT id FROM events WHERE device_id = ?', deviceId).map(r => r.id);
      if (eventIds.length > 0) {
        const placeholders = eventIds.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM otp_claims WHERE event_id IN (${placeholders})`).run(...eventIds);
      }

      for (const table of ['events', 'request_nonces', 'pairing_sessions', 'outbound_commands', 'device_lines', 'device_status', 'gateway_group_members']) {
        this.db.prepare(`DELETE FROM ${table} WHERE device_id = ?`).run(deviceId);
      }

      this.db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
      return true;
    });
  }

  /**
   * Compute device health status.
   */
  private deviceHealth(lastSeenAt: number | null, retiredAt: number | null, nowMs: number): string {
    if (retiredAt !== null) return 'RETIRED';
    if (lastSeenAt === null) return 'NEVER';
    const age = Math.max(0, nowMs - lastSeenAt);
    if (age <= DEVICE_ONLINE_WINDOW_MS) return 'ONLINE';
    if (age <= DEVICE_STALE_WINDOW_MS) return 'STALE';
    return 'OFFLINE';
  }

  /**
   * Convert database row to DeviceDetail.
   */
  private toDeviceDetail(row: any, lines: DeviceLineRow[], nowMs: number): DeviceDetail {
    const boolOrNone = (value: number | null): boolean | null => value === null ? null : Boolean(value);

    return {
      deviceId: row.device_id,
      description: row.description || '',
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      retiredAt: row.retired_at,
      health: this.deviceHealth(row.last_seen_at, row.retired_at, nowMs),
      status: {
        observedAt: row.observed_at,
        appVersion: row.app_version,
        versionCode: row.version_code,
        targetSdk: row.target_sdk,
        androidVersion: row.android_version,
        manufacturer: row.manufacturer,
        model: row.model,
        receiveMode: row.receive_mode,
        defaultSmsRole: boolOrNone(row.default_sms_role),
        permissions: {
          receiveSms: boolOrNone(row.receive_sms_granted),
          sendSms: boolOrNone(row.send_sms_granted),
          readPhoneState: boolOrNone(row.read_phone_state_granted),
        },
        lastIncomingSmsAt: row.last_incoming_sms_at,
        lastOtpAt: row.last_otp_at,
        lastOrdinarySmsAt: row.last_ordinary_sms_at,
        lastReceiverAction: row.last_receiver_action,
        lastReceiverActionAt: row.last_receiver_action_at,
        lastReceiverInvokedAt: row.last_receiver_invoked_at,
        lastReceiverInvokedAction: row.last_receiver_invoked_action,
        lastReceiverParseFailureAt: row.last_receiver_parse_failure_at,
        lastReceiverParseFailureReason: row.last_receiver_parse_failure_reason,
        lines: lines.map(l => ({
          slotIndex: l.slot_index,
          subscriptionId: l.subscription_id,
          carrierName: l.carrier_name,
          displayName: l.display_name,
          active: Boolean(l.is_active),
          observedAt: l.observed_at,
        })),
      },
    };
  }
}
