/**
 * Audit repository.
 *
 * Manages the admin_audit_log table.
 */

import type { DatabaseSync } from 'node:sqlite';
import { queryAll } from '../database/helpers.js';

export interface AuditEntry {
  id: number;
  occurredAt: number;
  clientId: string;
  action: string;
  deviceId: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
}

export class AuditRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * Record an audit entry.
   */
  record(
    clientId: string,
    action: string,
    deviceId: string | null,
    outcome: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.db.prepare(`
      INSERT INTO admin_audit_log(occurred_at, client_id, action, device_id, outcome, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), clientId, action, deviceId, outcome, JSON.stringify(metadata));
  }

  /**
   * List audit entries with pagination.
   */
  list(
    limit: number,
    options: {
      beforeId?: number;
      deviceIds?: Set<string>;
    } = {},
  ): AuditEntry[] {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (options.beforeId !== undefined) { clauses.push('id < ?'); params.push(options.beforeId); }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) return [];
      const ids = [...options.deviceIds].sort();
      clauses.push(`device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    params.push(Math.min(Math.max(limit, 1), 100));

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = queryAll<any>(this.db, `
      SELECT id, occurred_at, client_id, action, device_id, outcome, metadata_json
      FROM admin_audit_log ${where} ORDER BY id DESC LIMIT ?
    `, ...params);

    return rows.map(row => ({
      id: row.id,
      occurredAt: row.occurred_at,
      clientId: row.client_id,
      action: row.action,
      deviceId: row.device_id,
      outcome: row.outcome,
      metadata: JSON.parse(row.metadata_json),
    }));
  }
}
