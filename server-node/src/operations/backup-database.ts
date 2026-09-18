import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export async function backupDatabase(databasePath: string, outputDirectory: string, keep: number): Promise<string> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('keep must be at least 1');
  }
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '000Z');
  const destination = join(outputDirectory, `gateway-${timestamp}.db`);
  const temporary = `${destination}.partial`;
  rmSync(temporary, { force: true });

  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, temporary);
  } finally {
    source.close();
  }

  try {
    finalizeStandaloneDatabase(temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } finally {
    removeDatabaseFiles(temporary);
  }

  const backups = readdirSync(outputDirectory)
    .filter(name => /^gateway-.*\.db$/.test(name))
    .map(name => join(outputDirectory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const stale of backups.slice(keep)) rmSync(stale);
  for (const name of readdirSync(outputDirectory)) {
    if (/^gateway-.*\.db(?:\.partial)?-(?:wal|shm)$/.test(name)) {
      rmSync(join(outputDirectory, name), { force: true });
    }
  }
  return destination;
}

function finalizeStandaloneDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.exec('PRAGMA journal_mode = DELETE');
    const row = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (row.integrity_check !== 'ok') throw new Error('backup integrity check failed');
  } finally {
    database.close();
  }
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function removeDatabaseFiles(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const path = await backupDatabase(args.database, args.outputDirectory, args.keep);
  console.log(`Backup created: ${path}`);
}

function parseArguments(argv: string[]): { database: string; outputDirectory: string; keep: number } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    values.set(key, value);
  }
  const keepRaw = values.get('--keep') ?? '14';
  if (!/^\d+$/.test(keepRaw)) throw new Error('keep must be at least 1');
  return {
    database: values.get('--database') ?? '/var/lib/gateway/gateway.db',
    outputDirectory: values.get('--output-dir') ?? '/var/lib/gateway/backups',
    keep: Number(keepRaw),
  };
}

if (basename(process.argv[1] ?? '') === 'backup-database.js') {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
