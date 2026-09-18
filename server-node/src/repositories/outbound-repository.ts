/**
 * Outbound SMS command repository.
 *
 * Manages the outbound_commands table for remote SMS commands.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import { queryAll, queryOne } from '../database/helpers.js';
import { encryptPayload, decryptPayload } from '../crypto/payload-crypto.js';
import { randomBytes } from 'node:crypto';
import {
  OUTBOUND_STATUS_ORDER,
  OUTBOUND_COMMAND_LEASE_MS,
  OUTBOUND_COMMAND_STATUSES,
} from '../config/constants.js';

export interface OutboundCommandRow {
  id: number;
  command_id: string;
  idempotency_key: string;
  device_id: string;
  slot_index: number;
  envelope_json: string;
  status: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  updated_at: number;
  last_result_code: number | null;
  error_detail: string | null;
}

export interface OutboundCommand {
  id: number;
  commandId: string;
  deviceId: string;
  slotIndex: number;
  recipient: string | null;
  body: string | null;
  status: string;
  createdAt: number;
  expiresAt: number;
  claimedAt: number | null;
  updatedAt: number;
  lastResultCode: number | null;
  errorDetail: string | null;
}

export class OutboundRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Create a new outbound command.
   */
  create(
    deviceId: string,
    secret: Buffer,
    slotIndex: number,
    recipient: string,
    body: string,
    idempotencyKey: string,
    nowMs: number,
    expiresInSeconds: number,
  ): OutboundCommand {
    const commandId = randomBytes(18).toString('base64url');
    const expiresAt = nowMs + expiresInSeconds * 1000;

    const envelope = encryptPayload({
      schemaVersion: 1,
      deliveryId: commandId,
      sourceEventId: commandId,
      eventType: 'OUTBOUND_SMS_COMMAND',
      createdAt: nowMs,
      subscriptionId: null,
      slotIndex,
      payload: { recipient, body },
    }, deviceId, secret);

    return transaction(this.db, () => {
      const existing = queryOne<OutboundCommandRow>(this.db, 'SELECT * FROM outbound_commands WHERE idempotency_key = ?', idempotencyKey);
      if (existing) {
        const cmd = this.toCommand(existing, secret);
        if (existing.device_id !== deviceId || existing.slot_index !== slotIndex || cmd.recipient !== recipient || cmd.body !== body) {
          throw new Error('idempotency key conflict');
        }
        return cmd;
      }

      this.db.prepare(`
        INSERT INTO outbound_commands(command_id, idempotency_key, device_id, slot_index, envelope_json, status, created_at, expires_at, claimed_at, updated_at, last_result_code, error_detail)
        VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, NULL, ?, NULL, NULL)
      `).run(commandId, idempotencyKey, deviceId, slotIndex, JSON.stringify(envelope), nowMs, expiresAt, nowMs);

      const row = queryOne<OutboundCommandRow>(this.db, 'SELECT * FROM outbound_commands WHERE command_id = ?', commandId)!;
      return this.toCommand(row, secret);
    });
  }

  /**
   * List outbound commands with pagination.
   */
  list(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      beforeId?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): OutboundCommand[] {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (options.beforeId !== undefined) { clauses.push('id < ?'); params.push(options.beforeId); }
    if (options.deviceId !== undefined) { clauses.push('device_id = ?'); params.push(options.deviceId); }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) return [];
      const ids = [...options.deviceIds].sort();
      clauses.push(`device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    params.push(Math.min(Math.max(limit, 1), 100));

    const nowMs = Date.now();
    this.db.prepare("UPDATE outbound_commands SET status = 'EXPIRED', updated_at = ? WHERE status IN ('QUEUED', 'CLAIMED') AND expires_at <= ?").run(nowMs, nowMs);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = queryAll<OutboundCommandRow>(this.db, `SELECT * FROM outbound_commands ${where} ORDER BY id DESC LIMIT ?`, ...params);

    return rows
      .map(row => {
        const secret = secrets.get(row.device_id);
        return secret ? this.toCommand(row, secret) : null;
      })
      .filter((c): c is OutboundCommand => c !== null);
  }

  /**
   * Claim outbound commands for a device.
   */
  claim(deviceId: string, secret: Buffer, limit: number, nowMs: number): OutboundCommand[] {
    return transaction(this.db, () => {
      this.db.prepare("UPDATE outbound_commands SET status = 'EXPIRED', updated_at = ? WHERE device_id = ? AND status IN ('QUEUED', 'CLAIMED') AND expires_at <= ?").run(nowMs, deviceId, nowMs);
      this.db.prepare("UPDATE outbound_commands SET status = 'QUEUED', claimed_at = NULL, updated_at = ? WHERE device_id = ? AND status = 'CLAIMED' AND claimed_at <= ? AND expires_at > ?").run(nowMs, deviceId, nowMs - OUTBOUND_COMMAND_LEASE_MS, nowMs);

      const rows = queryAll<OutboundCommandRow>(this.db, `
        SELECT * FROM outbound_commands
        WHERE device_id = ? AND status = 'QUEUED' AND expires_at > ?
        ORDER BY id ASC LIMIT ?
      `, deviceId, nowMs, Math.min(Math.max(limit, 1), 10));

      if (rows.length === 0) return [];

      const commandIds = rows.map(r => r.command_id);
      const placeholders = commandIds.map(() => '?').join(',');
      this.db.prepare(`UPDATE outbound_commands SET status = 'CLAIMED', claimed_at = ?, updated_at = ? WHERE command_id IN (${placeholders}) AND status = 'QUEUED'`).run(nowMs, nowMs, ...commandIds);

      const claimed = queryAll<OutboundCommandRow>(this.db, `SELECT * FROM outbound_commands WHERE command_id IN (${placeholders}) ORDER BY id ASC`, ...commandIds);
      return claimed.map(row => this.toCommand(row, secret));
    });
  }

  /**
   * Update outbound command status from device.
   */
  updateStatus(deviceId: string, payload: Record<string, unknown>, nowMs: number): boolean {
    const commandId = payload.commandId;
    const status = payload.status;
    const resultCode = payload.resultCode;
    const errorDetail = payload.errorDetail;

    if (
      typeof commandId !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(commandId)
      || typeof status !== 'string'
      || !OUTBOUND_COMMAND_STATUSES.has(status)
      || status === 'QUEUED'
      || status === 'CLAIMED'
      || status === 'EXPIRED'
      || (resultCode != null && (typeof resultCode !== 'number' || !Number.isInteger(resultCode)))
      || (errorDetail != null && typeof errorDetail !== 'string')
    ) {
      throw new Error('invalid outbound status');
    }

    const row = queryOne<{ status: string }>(this.db, 'SELECT status FROM outbound_commands WHERE command_id = ? AND device_id = ?', commandId, deviceId);
    if (!row) return false;

    if (['DELIVERED', 'FAILED', 'EXPIRED'].includes(row.status)) return true;
    if ((OUTBOUND_STATUS_ORDER[status] ?? 0) < (OUTBOUND_STATUS_ORDER[row.status] ?? 0)) return true;

    const normalizedError = errorDetail == null ? null : errorDetail.trim().slice(0, 256);
    this.db.prepare('UPDATE outbound_commands SET status = ?, updated_at = ?, last_result_code = ?, error_detail = ? WHERE command_id = ? AND device_id = ?').run(status, nowMs, resultCode ?? null, normalizedError, commandId, deviceId);
    return true;
  }

  private toCommand(row: OutboundCommandRow, secret: Buffer): OutboundCommand {
    const envelope = decryptPayload(JSON.parse(row.envelope_json), row.device_id, secret);
    const payload = envelope.payload as Record<string, unknown>;
    return {
      id: row.id,
      commandId: row.command_id,
      deviceId: row.device_id,
      slotIndex: row.slot_index,
      recipient: (payload.recipient as string) || null,
      body: (payload.body as string) || null,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      updatedAt: row.updated_at,
      lastResultCode: row.last_result_code,
      errorDetail: row.error_detail,
    };
  }
}
