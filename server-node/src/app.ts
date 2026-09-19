/**
 * Fastify composition root.
 *
 * Configuration parsing, protocol authentication and transactional ingestion
 * live in dedicated modules; this file only wires dependencies and HTTP-wide
 * behavior.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, initializeDatabase } from './database/database.js';
import type { DatabaseConfig } from './database/database.js';
import { DeviceRepository } from './repositories/device-repository.js';
import { DeviceStateRepository } from './repositories/device-state-repository.js';
import { EventRepository } from './repositories/event-repository.js';
import { OutboundRepository } from './repositories/outbound-repository.js';
import { OtpRepository } from './repositories/otp-repository.js';
import { PairingRepository } from './repositories/pairing-repository.js';
import { GroupRepository } from './repositories/group-repository.js';
import { AuditRepository } from './repositories/audit-repository.js';
import { NotificationRepository } from './repositories/notification-repository.js';
import {
  verifyApiClient,
  type ApiClient,
  canAccessDevice,
  getClientAllowedDeviceIds,
  getClientDeviceSecrets,
} from './auth/api-client-auth.js';
import { SlidingWindowRateLimiter } from './auth/rate-limiter.js';
import { RateLimitError } from './auth/auth-errors.js';
import {
  emptyRuntimeConfig,
  loadRuntimeConfig,
  type RuntimeConfig,
} from './config/runtime-config.js';
import { API_VERSION, MAX_BODY_BYTES, PROTOCOL_SCHEMA_VERSION, SERVICE_VERSION } from './config/constants.js';
import { registerRawJsonParser } from './http/raw-json.js';
import { DeviceRequestAuthenticator } from './services/device-request-authenticator.js';
import { EventIngestionService } from './services/event-ingestion-service.js';
import { NotificationDispatcher } from './services/notification-dispatcher.js';
import {
  FeishuWebhookClient,
  type NotificationTransport,
} from './notifications/feishu-client.js';
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
import { ingestRoutes } from './routes/ingest-routes.js';
import { notificationRoutes } from './routes/notification-routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
    runtimeConfig: RuntimeConfig;
    deviceRepo: DeviceRepository;
    deviceStateRepo: DeviceStateRepository;
    eventRepo: EventRepository;
    outboundRepo: OutboundRepository;
    otpRepo: OtpRepository;
    pairingRepo: PairingRepository;
    groupRepo: GroupRepository;
    auditRepo: AuditRepository;
    notificationRepo: NotificationRepository;
    apiClients: Map<string, ApiClient>;
    deviceSecrets: Map<string, Buffer>;
    rateLimiter: SlidingWindowRateLimiter;
    deviceAuthenticator: DeviceRequestAuthenticator;
    eventIngestionService: EventIngestionService;
    notificationDispatcher: NotificationDispatcher | null;
    verifyApi: (request: FastifyRequest, requiredScope: string) => string;
    verifyDeviceAccess: (clientId: string, deviceId: string) => boolean;
    getAllowedDeviceIds: (clientId: string) => Set<string> | null;
    getClientSecrets: (clientId: string) => Map<string, Buffer>;
    refreshDeviceSecrets: () => void;
  }
}

export interface AppConfig {
  database: DatabaseConfig;
  configPath?: string;
  runtimeConfig?: RuntimeConfig;
  trustProxy?: boolean;
  notificationTransport?: NotificationTransport;
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const runtimeConfig = config.runtimeConfig
    ?? (config.configPath ? loadRuntimeConfig(config.configPath) : emptyRuntimeConfig());

  const app = Fastify({
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.body.payload', '*.body', '*.sender', '*.otp', '*.code'],
    },
    trustProxy: config.trustProxy ?? runtimeConfig.server.trustProxyHeaders,
    bodyLimit: MAX_BODY_BYTES,
  });
  registerRawJsonParser(app);
  const db = openDatabase(config.database);
  try {
    initializeDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const deviceRepo = new DeviceRepository(db);
  if (runtimeConfig.configuredDevices.size > 0) {
    deviceRepo.migrateFromConfig(runtimeConfig.configuredDevices, Date.now());
  }
  const eventRepo = new EventRepository(db);
  const deviceStateRepo = new DeviceStateRepository(db);
  const outboundRepo = new OutboundRepository(db);
  const otpRepo = new OtpRepository(db);
  const pairingRepo = new PairingRepository(db);
  const groupRepo = new GroupRepository(db);
  const auditRepo = new AuditRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const deviceSecrets = deviceRepo.loadSecrets();
  const rateLimiter = new SlidingWindowRateLimiter();
  const deviceAuthenticator = new DeviceRequestAuthenticator(
    deviceRepo,
    deviceSecrets,
    rateLimiter,
    runtimeConfig.server,
  );
  const eventIngestionService = new EventIngestionService(
    db,
    deviceRepo,
    deviceStateRepo,
    eventRepo,
    outboundRepo,
    notificationRepo,
    runtimeConfig.server.retentionDays,
  );
  const notificationTransport = config.notificationTransport
    ?? (runtimeConfig.notifications.feishu
      ? new FeishuWebhookClient(runtimeConfig.notifications.feishu)
      : null);
  const notificationDispatcher = notificationTransport
    ? new NotificationDispatcher(
      notificationRepo,
      notificationTransport,
      deviceSecrets,
    )
    : null;

  app.decorate('db', db);
  app.decorate('runtimeConfig', runtimeConfig);
  app.decorate('deviceRepo', deviceRepo);
  app.decorate('deviceStateRepo', deviceStateRepo);
  app.decorate('eventRepo', eventRepo);
  app.decorate('outboundRepo', outboundRepo);
  app.decorate('otpRepo', otpRepo);
  app.decorate('pairingRepo', pairingRepo);
  app.decorate('groupRepo', groupRepo);
  app.decorate('auditRepo', auditRepo);
  app.decorate('notificationRepo', notificationRepo);
  app.decorate('apiClients', runtimeConfig.apiClients);
  app.decorate('deviceSecrets', deviceSecrets);
  app.decorate('rateLimiter', rateLimiter);
  app.decorate('deviceAuthenticator', deviceAuthenticator);
  app.decorate('eventIngestionService', eventIngestionService);
  app.decorate('notificationDispatcher', notificationDispatcher);

  app.decorate('verifyApi', function verifyApi(request: FastifyRequest, requiredScope: string): string {
    return verifyApiClient(
      request.headers.authorization,
      requiredScope,
      app.apiClients,
      app.rateLimiter,
      request.ip,
      app.runtimeConfig.server.apiAuthRequestsPerMinute,
      app.runtimeConfig.server.apiRequestsPerMinute,
    );
  });
  app.decorate('verifyDeviceAccess', (clientId: string, deviceId: string) => (
    canAccessDevice(clientId, deviceId, app.apiClients)
  ));
  app.decorate('getAllowedDeviceIds', (clientId: string) => (
    getClientAllowedDeviceIds(clientId, app.apiClients)
  ));
  app.decorate('getClientSecrets', (clientId: string) => (
    getClientDeviceSecrets(clientId, app.apiClients, app.deviceSecrets)
  ));
  app.decorate('refreshDeviceSecrets', () => {
    const current = app.deviceRepo.loadSecrets();
    app.deviceSecrets.clear();
    for (const [deviceId, secret] of current) {
      app.deviceSecrets.set(deviceId, secret);
    }
  });

  registerConcurrencyLimit(app, runtimeConfig.server.maxConcurrentRequests);
  registerSecurityHeaders(app);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/version', async () => ({
    service: 'caconnection-gateway',
    version: SERVICE_VERSION,
    apiVersion: API_VERSION,
    protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
  }));
  app.get('/ready', async (_, reply) => {
    try {
      const databaseReady = db.prepare('SELECT 1').get() !== undefined;
      const ready = databaseReady && app.deviceSecrets.size > 0 && app.apiClients.size > 0;
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number; retryAfterMs?: number }, _request, reply) => {
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
  await app.register(notificationRoutes);
  await app.register(ingestRoutes);

  app.addHook('onReady', async () => {
    notificationDispatcher?.start();
  });
  app.addHook('onClose', async () => {
    await notificationDispatcher?.stop();
    db.close();
  });

  return app;
}

function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
}

function registerConcurrencyLimit(app: FastifyInstance, maximum: number): void {
  let active = 0;
  const admitted = new Set<string>();
  app.addHook('onRequest', async (request, reply) => {
    if (active >= maximum) {
      throw new RateLimitError(1_000);
    }
    active += 1;
    admitted.add(request.id);
    void reply;
  });
  const release = (request: FastifyRequest) => {
    if (admitted.delete(request.id)) active -= 1;
  };
  app.addHook('onResponse', async request => release(request));
  app.addHook('onError', async request => release(request));
}
