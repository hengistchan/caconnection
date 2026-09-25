/**
 * SQLite database connection using Node.js built-in node:sqlite (Node 22+).
 *
 * Must match the Python gateway's schema exactly.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export interface DatabaseConfig {
  path: string;
}

/**
 * Open an independent database connection.
 *
 * Each Fastify application owns its connection. Avoiding a process-global
 * singleton keeps tests isolated and makes graceful shutdown deterministic.
 */
export function openDatabase(config: DatabaseConfig): DatabaseSync {
  const dir = join(config.path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(config.path, {
    open: true,
    enableForeignKeyConstraints: true,
    readOnly: false,
  });

  // Configure pragmas to match Python gateway
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');

  return db;
}

/**
 * Initialize the database schema.
 * This creates all tables if they don't exist.
 */
export function initializeDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      subscription_id INTEGER,
      slot_index INTEGER,
      envelope_json TEXT NOT NULL,
      UNIQUE(device_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS request_nonces (
      device_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, nonce)
    );

    CREATE TABLE IF NOT EXISTS otp_claims (
      event_id INTEGER PRIMARY KEY,
      client_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pairing_sessions (
      token_sha256 TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS outbound_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      updated_at INTEGER NOT NULL,
      last_result_code INTEGER,
      error_detail TEXT
    );

    CREATE INDEX IF NOT EXISTS index_events_type_received
      ON events(event_type, received_at DESC);

    CREATE TABLE IF NOT EXISTS call_ringing_sessions (
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      first_event_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, session_id),
      FOREIGN KEY(first_event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS index_pairing_sessions_expiry
      ON pairing_sessions(expires_at);

    CREATE INDEX IF NOT EXISTS index_outbound_commands_device_status
      ON outbound_commands(device_id, status, created_at);

    CREATE INDEX IF NOT EXISTS index_outbound_commands_created
      ON outbound_commands(created_at DESC);

    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      secret_base64 TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      retired_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS device_status (
      device_id TEXT PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      app_version TEXT,
      version_code INTEGER,
      target_sdk INTEGER,
      android_version TEXT,
      manufacturer TEXT,
      model TEXT,
      receive_mode TEXT,
      default_sms_role INTEGER,
      receive_sms_granted INTEGER,
      send_sms_granted INTEGER,
      read_phone_state_granted INTEGER,
      last_incoming_sms_at INTEGER,
      last_otp_at INTEGER,
      last_ordinary_sms_at INTEGER,
      last_receiver_action TEXT,
      last_receiver_action_at INTEGER,
      last_receiver_invoked_at INTEGER,
      last_receiver_invoked_action TEXT,
      last_receiver_parse_failure_at INTEGER,
      last_receiver_parse_failure_reason TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(device_id) REFERENCES devices(device_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_lines (
      device_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      subscription_id INTEGER,
      carrier_name TEXT,
      display_name TEXT,
      is_active INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, slot_index),
      FOREIGN KEY(device_id) REFERENCES devices(device_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      action TEXT NOT NULL,
      device_id TEXT,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS index_admin_audit_occurred
      ON admin_audit_log(occurred_at DESC);

    CREATE TABLE IF NOT EXISTS gateway_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_group_members (
      group_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY(group_id, device_id),
      FOREIGN KEY(group_id) REFERENCES gateway_groups(group_id)
        ON DELETE CASCADE,
      FOREIGN KEY(device_id) REFERENCES devices(device_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gateway_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      enabled INTEGER NOT NULL,
      content_mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO notification_settings(
      id, enabled, content_mode, updated_at
    ) VALUES (1, 0, 'REDACTED', 0);

    CREATE TABLE IF NOT EXISTS notification_channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      content_mode TEXT NOT NULL,
      event_types_json TEXT NOT NULL,
      configured INTEGER NOT NULL,
      signing_enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      event_id INTEGER,
      kind TEXT NOT NULL,
      notification_event_type TEXT,
      content_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      lease_started_at INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      last_error TEXT,
      alert_payload_json TEXT,
      UNIQUE(channel, event_id),
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS index_notification_outbox_due
      ON notification_outbox(status, next_attempt_at, id);

    CREATE TABLE IF NOT EXISTS device_liveness_state (
      device_id TEXT PRIMARY KEY,
      alert_level INTEGER NOT NULL,
      offline_since INTEGER,
      last_alert_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(device_id) REFERENCES devices(device_id) ON DELETE CASCADE
    );
  `);

  // Handle schema migrations for columns added after initial release
  const deviceColumns = new Set(
    db.prepare('PRAGMA table_info(devices)').all().map((row: any) => row.name)
  );
  if (!deviceColumns.has('retired_at')) {
    db.exec('ALTER TABLE devices ADD COLUMN retired_at INTEGER');
  }

  const statusColumns = new Set(
    db.prepare('PRAGMA table_info(device_status)').all().map((row: any) => row.name)
  );
  const migrations: Array<[string, string]> = [
    ['last_receiver_invoked_at', 'INTEGER'],
    ['last_receiver_invoked_action', 'TEXT'],
    ['last_receiver_parse_failure_at', 'INTEGER'],
    ['last_receiver_parse_failure_reason', 'TEXT'],
  ];
  for (const [col, type] of migrations) {
    if (!statusColumns.has(col)) {
      db.exec(`ALTER TABLE device_status ADD COLUMN ${col} ${type}`);
    }
  }

  const callSessionColumns = new Set(
    db.prepare('PRAGMA table_info(call_ringing_sessions)').all().map((row: any) => row.name)
  );
  if (!callSessionColumns.has('answered_at')) {
    db.exec('ALTER TABLE call_ringing_sessions ADD COLUMN answered_at INTEGER');
  }
  if (!callSessionColumns.has('ended_at')) {
    db.exec('ALTER TABLE call_ringing_sessions ADD COLUMN ended_at INTEGER');
  }
  if (!callSessionColumns.has('ended_event_id')) {
    db.exec('ALTER TABLE call_ringing_sessions ADD COLUMN ended_event_id INTEGER');
  }

  const notificationOutboxColumns = new Set(
    db.prepare('PRAGMA table_info(notification_outbox)').all().map((row: any) => row.name)
  );
  if (!notificationOutboxColumns.has('notification_event_type')) {
    db.exec('ALTER TABLE notification_outbox ADD COLUMN notification_event_type TEXT');
  }
  if (!notificationOutboxColumns.has('alert_payload_json')) {
    db.exec('ALTER TABLE notification_outbox ADD COLUMN alert_payload_json TEXT');
  }
}
