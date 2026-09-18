/** Main entry point for the CAConnection Gateway. */

import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const PORT = parsePort(process.env.PORT ?? '8787');
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_PATH = process.env.DATABASE_PATH ?? join(import.meta.dirname, '..', 'data', 'gateway.db');
const CONFIG_PATH = process.env.CONFIG_PATH;

let app: FastifyInstance | undefined;
let shuttingDown = false;

async function main(): Promise<void> {
  if (!CONFIG_PATH) {
    throw new Error('CONFIG_PATH is required');
  }
  app = await buildApp({
    database: { path: DATABASE_PATH },
    configPath: CONFIG_PATH,
  });
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ host: HOST, port: PORT }, 'gateway receiver listening');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    app?.log.info({ signal }, 'shutting down gracefully');
    if (app) await app.close();
  } catch (error) {
    console.error('graceful shutdown failed', error);
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

main().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  if (app) await app.close().catch(() => undefined);
});

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('PORT must be an integer');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  return port;
}
