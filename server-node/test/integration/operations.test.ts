import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase } from '../../src/operations/backup-database.js';
import { restoreDatabase } from '../../src/operations/restore-database.js';

describe('database operations', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates an integrity-checked backup and restores it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-operations-'));
    directories.push(directory);
    const databasePath = join(directory, 'gateway.db');
    const backupDirectory = join(directory, 'backups');

    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE test_data(value TEXT NOT NULL)');
    database.prepare('INSERT INTO test_data(value) VALUES (?)').run('before-backup');
    database.close();

    const backupPath = await backupDatabase(databasePath, backupDirectory, 14);

    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE test_data SET value = ?').run('after-backup');
    changed.close();

    await restoreDatabase(backupPath, databasePath);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(restored.prepare('SELECT value FROM test_data').get()).toEqual({ value: 'before-backup' });
    expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    restored.close();
  });

  it('prunes backups beyond the configured retention count', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-operations-'));
    directories.push(directory);
    const databasePath = join(directory, 'gateway.db');
    const backupDirectory = join(directory, 'backups');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE test_data(value TEXT NOT NULL)');
    database.close();

    await backupDatabase(databasePath, backupDirectory, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    await backupDatabase(databasePath, backupDirectory, 1);

    expect(readdirSync(backupDirectory).filter(name => name.endsWith('.db'))).toHaveLength(1);
  });
});
