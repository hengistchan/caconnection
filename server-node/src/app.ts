/**
 * Fastify application factory.
 *
 * Creates and configures the Fastify instance with all plugins and routes.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { getDatabase, initializeDatabase, closeDatabase } from './database/database.js';
import type { DatabaseConfig } from './database/database.js';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceRepository } from './repositories/device-repository.js';
import { EventRepository } from './repositories/event-repository.js';
import { OutboundRepository } from './repositories/outbound-repository.js';
import { OtpRepository } from './repositories/otp-repository.js';
import { PairingRepository } from './repositories/pairing-repository.js';
import { GroupRepository } from './repositories/group-repository.js';
import { AuditRepository } from './repositories/audit-repository.js';
import { loadApiClients, type ApiClient, canAccessDevice, getClientAllowedDeviceIds, getClientDeviceSecrets } from './auth/api-client-auth.js';
import { SlidingWindowRateLimiter } from './auth/rate-limiter.js';
import { messageRoutes } from './routes/message-routes.js';
import { outboundRoutes } from './routes/outbound-routes.js';
import { deviceRoutes } from './routes/device-routes.js';
import { groupRoutes } from './routes/group-routes.js';
import { auditRoutes } from './routes/audit-routes.js';
import { deviceCommandRoutes } from './routes/device-command-routes.js';
import { groupCommandRoutes } from './routes/group-command-routes.js';
import { otpRoutes } from './routes/otp-routes.js';
import { outboundCommandRoutes } from './routes/outbound-command-routes.js';
import { pairingRoutes } from './routes/pairing-routes.js';

// Extend Fastify instance type
declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
    deviceRepo: DeviceRepository;
    eventRepo: EventRepository;
    outboundRepo: OutboundRepository;
    otpRepo: OtpRepository;
    pairingRepo: PairingRepository;
    groupRepo: GroupRepository;
    auditRepo: AuditRepository;
    apiClients: Map<string, ApiClient>;
    deviceSecrets: Map<string, Buffer>;
    rateLimiter: SlidingWindowRateLimiter;
    verifyApi: (request: FastifyRequest, requiredScope: string) => string;
    verifyDeviceAccess: (clientId: string, deviceId: string) => boolean;
    getAllowedDeviceIds: (clientId: string) => Set<string> | null;
    getClientSecrets: (clientId: string) => Map<string, Buffer>;
  }
}

export interface AppConfig {
  database: DatabaseConfig;
  trustProxy?: boolean;
  configPath?: string;
}

/**
 * Build and configure the Fastify application.
 */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
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

  // Create repositories
  const deviceRepo = new DeviceRepository(db);
  const eventRepo = new EventRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const otpRepo = new OtpRepository(db);
  const pairingRepo = new PairingRepository(db);
  const groupRepo = new GroupRepository(db);
  const auditRepo = new AuditRepository(db);

  // Load API clients from config
  let apiClients = new Map<string, ApiClient>();
  if (config.configPath) {
    try {
      const configData = JSON.parse(require('fs').readFileSync(config.configPath, 'utf-8'));
      apiClients = loadApiClients(configData);
    } catch {
      // No config file or invalid - will have no API clients
    }
  }

  // Load device secrets
  const deviceSecrets = deviceRepo.loadSecrets();

  // Rate limiter
  const rateLimiter = new SlidingWindowRateLimiter();

  // Decorate app with instances
  app.decorate('db', db);
  app.decorate('deviceRepo', deviceRepo);
  app.decorate('eventRepo', eventRepo);
  app.decorate('outboundRepo', outboundRepo);
  app.decorate('otpRepo', otpRepo);
  app.decorate('pairingRepo', pairingRepo);
  app.decorate('groupRepo', groupRepo);
  app.decorate('auditRepo', auditRepo);
  app.decorate('apiClients', apiClients);
  app.decorate('deviceSecrets', deviceSecrets);
  app.decorate('rateLimiter', rateLimiter);

  // Helper methods for auth
  app.decorate('verifyApi', function(request: any, requiredScope: string): string {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw { statusCode: 401, message: 'authentication required' };
    }
    const token = auth.slice(7).trim();
    const tokenHash = require('node:crypto').createHash('sha256').update(token, 'utf-8').digest('hex');

    for (const [clientId, client] of apiClients) {
      if (require('node:crypto').timingSafeEqual(Buffer.from(client.tokenSha256, 'utf-8'), Buffer.from(tokenHash, 'utf-8'))) {
        if (!client.scopes.has(requiredScope) && !client.scopes.has('*')) {
          throw { statusCode: 403, message: 'insufficient scope' };
        }
        return clientId;
      }
    }
    throw { statusCode: 401, message: 'authentication failed' };
  });

  app.decorate('verifyDeviceAccess', function(clientId: string, deviceId: string): boolean {
    return canAccessDevice(clientId, deviceId, apiClients);
  });

  app.decorate('getAllowedDeviceIds', function(clientId: string): Set<string> | null {
    return getClientAllowedDeviceIds(clientId, apiClients);
  });

  app.decorate('getClientSecrets', function(clientId: string): Map<string, Buffer> {
    return getClientDeviceSecrets(clientId, apiClients, deviceSecrets);
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Version endpoint
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

  // Error handler
  app.setErrorHandler((error: any, _request, reply) => {
    if (error.statusCode) {
      const headers: Record<string, string> = {};
      if (error.retryAfterMs) {
        headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
      }
      return reply.status(error.statusCode).headers(headers).send({ error: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'internal server error' });
  });

  // Register routes
  await app.register(messageRoutes);
  await app.register(outboundRoutes);
  await app.register(deviceRoutes);
  await app.register(groupRoutes);
  await app.register(auditRoutes);
  await app.register(deviceCommandRoutes);
  await app.register(groupCommandRoutes);
  await app.register(otpRoutes);
  await app.register(outboundCommandRoutes);
  await app.register(pairingRoutes);

  // Cleanup on shutdown
  app.addHook('onClose', async () => {
    closeDatabase();
  });

  return app;
}