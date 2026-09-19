import type { FastifyInstance } from 'fastify';
import { isNotificationContentMode } from '../notifications/renderer.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/v1/notification-settings', async (request, reply) => {
    const clientId = app.verifyApi(request, 'notifications:manage');
    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }
    return reply.send({
      settings: app.notificationRepo.getSettings(
        app.runtimeConfig.notifications.feishu !== null,
        app.runtimeConfig.notifications.feishu?.signingSecret !== null
          && app.runtimeConfig.notifications.feishu?.signingSecret !== undefined,
      ),
    });
  });

  app.put('/v1/notification-settings', async (request, reply) => {
    const clientId = app.verifyApi(request, 'notifications:manage');
    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }
    const body = request.body;
    if (
      !isRecord(body)
      || Object.keys(body).some(key => !['enabled', 'contentMode'].includes(key))
      || typeof body.enabled !== 'boolean'
      || typeof body.contentMode !== 'string'
      || !isNotificationContentMode(body.contentMode)
    ) {
      return reply.status(400).send({ error: 'invalid notification settings' });
    }
    if (body.enabled && !app.runtimeConfig.notifications.feishu) {
      return reply.status(409).send({ error: 'Feishu webhook is not configured' });
    }
    app.notificationRepo.updateSettings(body.enabled, body.contentMode, Date.now());
    app.auditRepo.record(clientId, 'NOTIFICATION_SETTINGS_UPDATE', null, 'SUCCESS', {
      enabled: body.enabled,
      contentMode: body.contentMode,
    });
    if (body.enabled) app.notificationDispatcher?.wake();
    return reply.send({
      settings: app.notificationRepo.getSettings(
        app.runtimeConfig.notifications.feishu !== null,
        app.runtimeConfig.notifications.feishu?.signingSecret !== null
          && app.runtimeConfig.notifications.feishu?.signingSecret !== undefined,
      ),
    });
  });

  app.post('/v1/notification-settings/test', async (request, reply) => {
    const clientId = app.verifyApi(request, 'notifications:manage');
    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }
    if (!app.runtimeConfig.notifications.feishu || !app.notificationDispatcher) {
      return reply.status(409).send({ error: 'Feishu webhook is not configured' });
    }
    if (!isRecord(request.body) || Object.keys(request.body).length !== 0) {
      return reply.status(400).send({ error: 'empty request required' });
    }
    const deliveryId = app.notificationRepo.enqueueTest(Date.now());
    app.auditRepo.record(clientId, 'NOTIFICATION_TEST_QUEUE', null, 'SUCCESS');
    app.notificationDispatcher.wake();
    return reply.status(202).send({ queued: true, deliveryId });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
