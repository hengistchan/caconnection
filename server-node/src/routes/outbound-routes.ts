/**
 * Outbound message routes - /v1/outbound-messages
 *
 * Read-only endpoint for querying outbound SMS commands.
 */

import type { FastifyInstance } from 'fastify';

export async function outboundRoutes(app: FastifyInstance) {
  /**
   * GET /v1/outbound-messages
   *
   * List remote outbound SMS commands and their current status.
   * Requires messages:send scope.
   */
  app.get('/v1/outbound-messages', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:send');
    const query = request.query as Record<string, string | undefined>;

    const allowedKeys = new Set(['limit', 'beforeId', 'deviceId', 'groupId']);
    for (const key of Object.keys(query)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'invalid query' });
      }
    }

    const limit = parseLimit(query.limit);
    const beforeId = parseOptionalId(query.beforeId);
    const deviceId = parseOptionalDeviceId(query.deviceId);
    const groupId = query.groupId;

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

    const outboundMessages = app.outboundRepo.list(secrets, limit, {
      beforeId,
      deviceId,
      deviceIds,
    });

    return reply.send({ outboundMessages });
  });
}

function parseLimit(value: string | undefined): number {
  const n = parseInt(value || '50', 10);
  return isNaN(n) ? 50 : Math.min(Math.max(n, 1), 100);
}

function parseOptionalId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) throw new Error('invalid beforeId');
  return n;
}

function parseOptionalDeviceId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error('invalid deviceId');
  return value;
}