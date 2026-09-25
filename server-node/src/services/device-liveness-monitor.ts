import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import type { NotificationRepository } from '../repositories/notification-repository.js';

export const DEVICE_OFFLINE_WARNING_MS = 30 * 60 * 1_000;
export const DEVICE_OFFLINE_CRITICAL_MS = 60 * 60 * 1_000;
export const DEVICE_RECOVERY_WINDOW_MS = 3 * 60 * 1_000;

interface DeviceLivenessRow {
  device_id: string;
  last_seen_at: number | null;
  alert_level: number | null;
  offline_since: number | null;
}

export class DeviceLivenessMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(
    private readonly db: DatabaseSync,
    private readonly notificationRepo: NotificationRepository,
    private readonly wakeNotifications: () => void,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  checkOnce(nowMs = Date.now()): number {
    const channels = this.notificationRepo.getOperationalChannels();
    const rows = this.db.prepare(`
      SELECT d.device_id, d.last_seen_at, s.alert_level, s.offline_since
      FROM devices d
      LEFT JOIN device_liveness_state s ON s.device_id = d.device_id
      WHERE d.retired_at IS NULL
      ORDER BY d.device_id
    `).all() as unknown as DeviceLivenessRow[];
    let queued = 0;

    for (const row of rows) {
      if (row.last_seen_at === null) continue;
      const currentLevel = row.alert_level ?? 0;
      const age = Math.max(0, nowMs - row.last_seen_at);
      const targetLevel = age >= DEVICE_OFFLINE_CRITICAL_MS
        ? 2
        : age >= DEVICE_OFFLINE_WARNING_MS
          ? 1
          : age <= DEVICE_RECOVERY_WINDOW_MS
            ? 0
            : currentLevel;
      if (targetLevel === currentLevel) continue;

      transaction(this.db, () => {
        if (targetLevel === 0) {
          this.notificationRepo.enqueueDeviceAlert(
            channels,
            'device.recovered',
            {
              alertType: 'RECOVERED',
              deviceId: row.device_id,
              lastSeenAt: row.last_seen_at,
              detectedAt: nowMs,
              outageDurationMs: row.offline_since === null
                ? 0
                : Math.max(0, nowMs - row.offline_since),
            },
            nowMs,
          );
          this.upsertState(row.device_id, 0, null, nowMs, nowMs);
        } else {
          const offlineSince = row.offline_since ?? row.last_seen_at;
          this.notificationRepo.enqueueDeviceAlert(
            channels,
            'device.offline',
            {
              alertType: targetLevel >= 2 ? 'CRITICAL' : 'WARNING',
              deviceId: row.device_id,
              lastSeenAt: row.last_seen_at,
              detectedAt: nowMs,
              outageDurationMs: age,
            },
            nowMs,
          );
          this.upsertState(row.device_id, targetLevel, offlineSince, nowMs, nowMs);
        }
      });
      queued += channels.length;
    }

    if (queued > 0) this.wakeNotifications();
    return queued;
  }

  private upsertState(
    deviceId: string,
    level: number,
    offlineSince: number | null,
    lastAlertAt: number,
    nowMs: number,
  ): void {
    this.db.prepare(`
      INSERT INTO device_liveness_state(
        device_id, alert_level, offline_since, last_alert_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        alert_level = excluded.alert_level,
        offline_since = excluded.offline_since,
        last_alert_at = excluded.last_alert_at,
        updated_at = excluded.updated_at
    `).run(deviceId, level, offlineSince, lastAlertAt, nowMs);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      try {
        this.checkOnce();
      } finally {
        if (!this.stopped) this.schedule(this.intervalMs);
      }
    }, delayMs);
    this.timer.unref();
  }
}
