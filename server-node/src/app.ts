/**
 * Fastify application factory.
 *
 * Creates and configures the Fastify instance with all plugins and routes.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { getDatabase, initializeDatabase, closeDatabase } from './database/database.js';
import type { DatabaseConfig } from './database/database.js';
import type { DatabaseSync } from 'node:sqlite';

// Extend Fastify instance type
declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
  }
}

export interface AppConfig {
  database: DatabaseConfig;
  trustProxy?: boolean;
}

/**
 * Build and configure the Fastify application.
 */
export async function buildApp(config: A！ppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.body.payload', '*.body', '*.sender', '*.otp', '*.code'],
    },
    trustProxy: config.trustProxy ?? false,
    bodyLimit: 1_048_576, // 1MB
  });

  // Initialize database
  const db = getDatabase(config.database);
  initializeDatabase(db);

  // Decorate app with database instance
  app.decorate('db', db);

  // Health check
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Version endpoint - must match Python exactly
  app.get('/version', async () => {
    return {
      service: 'caconnection-gateway',
      version: '0.5.0',
      apiVersion: 1,
      protocolSchemaVersion: 2,
    };
  });

  // Readiness check
  app.get('/ready', async (_, reply) => {
    try {
      const result = db.prepare('SELECT 1').get();
      const ready = result !== undefined;
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
      });
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  // Cleanup on shutdown
  app.addHook('onClose', async () => {
    closeDatabase();
  });

  return app;
}
