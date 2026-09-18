/**
 * Main entry point for the CA Connection Gateway server.
 */

import { buildApp } from './app.js';
import { join } from 'node:path';

const PORT = parseInt(process.env.PORT ?? '8787', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_PATH = process.env.DATABASE_PATH ?? join(import.meta.dirname, '..', 'data', 'gateway.db');
const CONFIG_PATH = process.env.CONFIG_PATH;

async function main() {
  const app = await buildApp({
    database: { path: DATABASE_PATH },
    trustProxy: process.env.TRUST_PROXY === 'true',
    configPath: CONFIG_PATH,
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`HTTPS gateway receiver listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

main();
