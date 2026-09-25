import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/database/database.js';
import { DeviceRepository } from '../../src/repositories/device-repository.js';
import { NotificationRepository } from '../../src/repositories/notification-repository.js';
import {
  DEVICE_OFFLINE_CRITICAL_MS,
  DEVICE_OFFLINE_WARNING_MS,
  DeviceLivenessMonitor,
} from '../../src/services/device-liveness-monitor.js';

describe('device liveness monitor', () => {
  let directory: string;
  let db: DatabaseSync;
  let deviceRepo: DeviceRepository;
  let notificationRepo: NotificationRepository;
  let wakes: number;
  let monitor: DeviceLivenessMonitor;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'gateway-liveness-'));
    db = new DatabaseSync(join(directory, 'gateway.db'), {
      open: true,
      enableForeignKeyConstraints: true,
    });
    initializeDatabase(db);
    deviceRepo = new DeviceRepository(db);
    deviceRepo.add('gateway-a', Buffer.alloc(32, 4).toString('base64'), 'Gateway A', 1_000);
    notificationRepo = new NotificationRepository(db);
    notificationRepo.updateSettings(true, 'REDACTED', 1_000);
    wakes = 0;
    monitor = new DeviceLivenessMonitor(db, notificationRepo, () => { wakes += 1; });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('queues warning, critical, and recovery once per transition', () => {
    const base = 10_000_000;
    deviceRepo.touchDevice('gateway-a', base);

    expect(monitor.checkOnce(base + DEVICE_OFFLINE_WARNING_MS)).toBe(1);
    expect(monitor.checkOnce(base + DEVICE_OFFLINE_WARNING_MS + 1)).toBe(0);
    expect(monitor.checkOnce(base + DEVICE_OFFLINE_CRITICAL_MS)).toBe(1);

    deviceRepo.touchDevice('gateway-a', base + DEVICE_OFFLINE_CRITICAL_MS + 1_000);
    expect(monitor.checkOnce(base + DEVICE_OFFLINE_CRITICAL_MS + 2_000)).toBe(1);
    expect(wakes).toBe(3);

    expect(db.prepare(`
      SELECT notification_event_type, kind
      FROM notification_outbox
      ORDER BY id
    `).all()).toEqual([
      { notification_event_type: 'device.offline', kind: 'DEVICE_ALERT' },
      { notification_event_type: 'device.offline', kind: 'DEVICE_ALERT' },
      { notification_event_type: 'device.recovered', kind: 'DEVICE_ALERT' },
    ]);
  });

  it('does not alert before the warning threshold', () => {
    const base = 10_000_000;
    deviceRepo.touchDevice('gateway-a', base);
    expect(monitor.checkOnce(base + DEVICE_OFFLINE_WARNING_MS - 1)).toBe(0);
    expect(wakes).toBe(0);
  });

  it('loads the persisted operational alert payload for delivery', () => {
    const base = 10_000_000;
    deviceRepo.touchDevice('gateway-a', base);
    monitor.checkOnce(base + DEVICE_OFFLINE_WARNING_MS);

    const delivery = notificationRepo.claimDue(base + DEVICE_OFFLINE_WARNING_MS);
    expect(delivery).not.toBeNull();
    expect(delivery?.kind).toBe('DEVICE_ALERT');
    expect(delivery?.notificationEventType).toBe('device.offline');
    expect(delivery?.alertPayload).toMatchObject({
      alertType: 'WARNING',
      deviceId: 'gateway-a',
      lastSeenAt: base,
    });
  });
});
