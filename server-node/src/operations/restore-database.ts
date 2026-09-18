import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export async function restoreDatabase(sourcePath: string, databasePath: string): Promise<void> {
  if (!statSync(sourcePath).isFile()) throw new Error('backup file does not exist');
  assertIntegrity(sourcePath, 'backup integrity check failed');

  mkdirSync(dirname(databasePath), { recursive: true });
  const temporary = `${databasePath}.restore`;
  for (const path of [temporary, `${temporary}-wal`, `${temporary}-shm`]) rmSync(path, { force: true });

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, temporary);
  } finally {
    source.close();
  }

  try {
    assertIntegrity(temporary, 'restored database integrity check failed');
    chmodSync(temporary, 0o600);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    renameSync(temporary, databasePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertIntegrity(path: string, message: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (row.integrity_check !== 'ok') throw new Error(message);
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await restoreDatabase(args.source, args.database);
  console.log(`Database restored from: ${args.source}`);
}

function parseArguments(argv: string[]): { source: string; database: string } {
  let source: string | undefined;
  let database = '/var/lib/gateway/gateway.db';
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm-gateway-stopped') {
      confirmed = true;
    } else if (argument === '--source' || argument === '--database') {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${argument}`);
      if (argument === '--source') source = value;
      else database = value;
      index += 1;
    } else {
      throw new Error('invalid arguments');
    }
  }
  if (!confirmed) throw new Error('--confirm-gateway-stopped is required');
  if (!source) throw new Error('--source is required');
  return { source, database };
}

if (basename(process.argv[1] ?? '') === 'restore-database.js') {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
