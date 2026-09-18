/**
 * Outbound message routes - /v1/outbound-messages
 *
 * Read-only endpoint for querying outbound SMS commands.
 */

import type { FastifyInstance } from 'fastify';
import {
  assertAllowedQuery,
  InvalidQueryError,
  parseBeforeId,
  parseIdentifier,
  parseLimit,
} from '../http/query-validation.js';

export async function outboundRoutes(app: FastifyInstance) {
  /**
   * GET /v1/outbound-messages
   *
   * List remote outbound SMS commands and their current status.
   * Requires messages:send scope.
   */
  app.get('/v1/outbound-messages', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:send');
    const query = request.query as Record<string, unknown>;
    let limit: number;
    let beforeId: number | undefined;
    let deviceId: string | undefined;
    let groupId: string | undefined;
    try {
      assertAllowedQuery(query, new Set(['limit', 'beforeId', 'deviceId', 'groupId']));
      limit = parseLimit(query.limit);
      beforeId = parseBeforeId(query.beforeId);
      deviceId = parseIdentifier(query.deviceId);
      groupId = parseIdentifier(query.groupId);
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

    const outboundMessages = app.outboundRepo.list(secrets, limit, {
      beforeId,
      deviceId,
      deviceIds,
    });

    return reply.send({ outboundMessages });
  });
}
