/**
 * Message routes - /v1/messages, /v1/notifications
 *
 * Read-only endpoints for querying incoming messages and notifications.
 */

import type { FastifyInstance } from 'fastify';

export async function messageRoutes(app: FastifyInstance) {
  /**
   * GET /v1/messages
   *
   * Read decrypted incoming SMS messages.
   * Requires messages:read scope.
   */
  app.get('/v1/messages', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:read');
    const query = request.query as Record<string, string | undefined>;

    // Validate query parameters
    const allowedKeys = new Set(['limit', 'afterId', 'beforeId', 'slotIndex', 'deviceId', 'groupId']);
    for (const key of Object.keys(query)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'invalid query' });
      }
    }

    const limit = parseLimit(query.limit);
    const afterId = parseOptionalId(query.afterId, 'afterId');
    const beforeId = parseOptionalId(query.beforeId, 'beforeId');
    const slotIndex = parseOptionalSlotIndex(query.slotIndex);
    const deviceId = parseOptionalDeviceId(query.deviceId);
    const groupId = query.groupId;

    if (afterId !== undefined && beforeId !== undefined) {
      return reply.status(400).send({ error: 'conflicting cursors' });
    }
    if (groupId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) {
      return reply.status(400).send({ error: 'invalid groupId' });
    }
    if (deviceId !== undefined && groupId !== undefined) {
      return reply.status(400).send({ error: 'conflicting device filters' });
    }

    // Check device access
    if (deviceId !== undefined && !app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const secrets = app.getClientSecrets(clientId);
    let deviceIds: Set<string> | undefined;

    if (groupId !== undefined) {
      const groupDevices = app.groupRepo.getDeviceIds(groupId);
      if (!groupDevices) {
        return reply.status(404).send({ error: 'device group not found' });
      }
      const allowed = app.getAllowedDeviceIds(clientId);
      if (allowed !== null) {
        deviceIds = new Set([...groupDevices].filter(id => allowed.has(id)));
        if (deviceIds.size === 0) {
          return reply.status(404).send({ error: 'device group not found' });
        }
      } else {
        deviceIds = groupDevices;
      }
    } else if (deviceId !== undefined) {
      deviceIds = new Set([deviceId]);
    } else {
      const allowed = app.getAllowedDeviceIds(clientId);
      if (allowed !== null) {
        deviceIds = allowed;
      }
    }

    const messages = app.eventRepo.getMessages(secrets, limit, {
      afterId,
      beforeId,
      slotIndex,
      deviceId,
      deviceIds,
    });

    return reply.send({ messages });
  });

  /**
   * GET /v1/notifications
   *
   * Read decrypted notifications.
   * Requires messages:read scope.
   */
  app.get('/v1/notifications', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:read');
    const query = request.query as Record<string, string | undefined>;

    const allowedKeys = new Set(['limit', 'afterId', 'beforeId', 'deviceId', 'groupId']);
    for (const key of Object.keys(query)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'invalid query' });
      }
    }

    const limit = parseLimit(query.limit);
    const afterId = parseOptionalId(query.afterId, 'afterId');
    const beforeId = parseOptionalId(query.beforeId, 'beforeId');
    const deviceId = parseOptionalDeviceId(query.deviceId);
    const groupId = query.groupId;

    if (afterId !== undefined && beforeId !== undefined) {
      return reply.status(400).send({ error: 'conflicting cursors' });
    }
    if (groupId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) {
      return reply.status(400).send({ error: 'invalid groupId' });
    }
    if (deviceId !== undefined && groupId !== undefined) {
      return reply.status(400).send({ error: 'conflicting device filters' });
    }

    if (deviceId !== undefined && !app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const secrets = app.getClientSecrets(clientId);
    let deviceIds: Set<string> | undefined;

    if (groupId !== undefined) {
      const groupDevices = app.groupRepo.getDeviceIds(groupId);
      if (!groupDevices) {
        return reply.status(404).send({ error: 'device group not found' });
      }
      const allowed = app.getAllowedDeviceIds(clientId);
      if (allowed !== null) {
        deviceIds = new Set([...groupDevices].filter(id => allowed.has(id)));
        if (deviceIds.size === 0) {
          return reply.status(404).send({ error: 'device group not found' });
        }
      } else {
        deviceIds = groupDevices;
      }
    } else if (deviceId !== undefined) {
      deviceIds = new Set([deviceId]);
    } else {
      const allowed = app.getAllowedDeviceIds(clientId);
      if (allowed !== null) {
        deviceIds = allowed;
      }
    }

    const notifications = app.eventRepo.getNotifications(secrets, limit, {
      afterId,
      beforeId,
      deviceId,
      deviceIds,
    });

    return reply.send({ notifications });
  });
}

function parseLimit(value: string | undefined): number {
  const n = parseInt(value || '50', 10);
  return isNaN(n) ? 50 : Math.min(Math.max(n, 1), 100);
}

function parseOptionalId(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < (name === 'afterId' ? 0 : 1)) {
    throw new Error(`invalid ${name}`);
  }
  return n;
}

function parseOptionalSlotIndex(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (n !== 0 && n !== 1) throw new Error('invalid slotIndex');
  return n;
}

function parseOptionalDeviceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error('invalid deviceId');
  return value;
}