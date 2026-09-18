/**
 * Message routes - /v1/messages, /v1/notifications
 *
 * Read-only endpoints for querying incoming messages and notifications.
 */

import type { FastifyInstance } from 'fastify';
import {
  assertAllowedQuery,
  InvalidQueryError,
  parseAfterId,
  parseBeforeId,
  parseIdentifier,
  parseLimit,
  parseSlotIndex,
} from '../http/query-validation.js';

export async function messageRoutes(app: FastifyInstance) {
  /**
   * GET /v1/messages
   *
   * Read decrypted incoming SMS messages.
   * Requires messages:read scope.
   */
  app.get('/v1/messages', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:read');
    const query = request.query as Record<string, unknown>;
    let limit: number;
    let afterId: number | undefined;
    let beforeId: number | undefined;
    let slotIndex: number | undefined;
    let deviceId: string | undefined;
    let groupId: string | undefined;
    try {
      assertAllowedQuery(query, new Set(['limit', 'afterId', 'beforeId', 'slotIndex', 'deviceId', 'groupId']));
      limit = parseLimit(query.limit);
      afterId = parseAfterId(query.afterId);
      beforeId = parseBeforeId(query.beforeId);
      slotIndex = parseSlotIndex(query.slotIndex);
      deviceId = parseIdentifier(query.deviceId);
      groupId = parseIdentifier(query.groupId);
      if (afterId !== undefined && beforeId !== undefined) throw new InvalidQueryError();
      if (deviceId !== undefined && groupId !== undefined) throw new InvalidQueryError();
    } catch {
      return reply.status(400).send({ error: 'invalid query' });
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
    const query = request.query as Record<string, unknown>;
    let limit: number;
    let afterId: number | undefined;
    let beforeId: number | undefined;
    let deviceId: string | undefined;
    let groupId: string | undefined;
    try {
      assertAllowedQuery(query, new Set(['limit', 'afterId', 'beforeId', 'deviceId', 'groupId']));
      limit = parseLimit(query.limit);
      afterId = parseAfterId(query.afterId);
      beforeId = parseBeforeId(query.beforeId);
      deviceId = parseIdentifier(query.deviceId);
      groupId = parseIdentifier(query.groupId);
      if (afterId !== undefined && beforeId !== undefined) throw new InvalidQueryError();
      if (deviceId !== undefined && groupId !== undefined) throw new InvalidQueryError();
    } catch {
      return reply.status(400).send({ error: 'invalid query' });
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
