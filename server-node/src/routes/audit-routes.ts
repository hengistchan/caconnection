/**
 * Audit routes - /v1/audit-log
 *
 * Read-only endpoint for querying administrative actions.
 */

import type { FastifyInstance } from 'fastify';
import { assertAllowedQuery, parseBeforeId, parseLimit } from '../http/query-validation.js';

export async function auditRoutes(app: FastifyInstance) {
  /**
   * GET /v1/audit-log
   *
   * List administrative actions without message or OTP content.
   * Requires pairing:create scope.
   */
  app.get('/v1/audit-log', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const query = request.query as Record<string, unknown>;
    let limit: number;
    let beforeId: number | undefined;
    try {
      assertAllowedQuery(query, new Set(['limit', 'beforeId']));
      limit = parseLimit(query.limit);
      beforeId = parseBeforeId(query.beforeId);
    } catch {
      return reply.status(400).send({ error: 'invalid query' });
    }

    const entries = app.auditRepo.list(limit, {
      beforeId,
      deviceIds: app.getAllowedDeviceIds(clientId) ?? undefined,
    });

    return reply.send({ entries });
  });
}
