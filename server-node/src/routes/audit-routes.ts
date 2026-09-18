/**
 * Audit routes - /v1/audit-log
 *
 * Read-only endpoint for querying administrative actions.
 */

import type { FastifyInstance } from 'fastify';

export async function auditRoutes(app: FastifyInstance) {
  /**
   * GET /v1/audit-log
   *
   * List administrative actions without message or OTP content.
   * Requires pairing:create scope.
   */
  app.get('/v1/audit-log', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const query = request.query as Record<string, string | undefined>;

    const allowedKeys = new Set(['limit', 'beforeId']);
    for (const key of Object.keys(query)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'invalid query' });
      }
    }

    const limit = parseLimit(query.limit);
    const beforeId = parseOptionalId(query.beforeId);

    const entries = app.auditRepo.list(limit, {
      beforeId,
      deviceIds: app.getAllowedDeviceIds(clientId) ?? undefined,
    });

    return reply.send({ entries });
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