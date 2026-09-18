/**
 * Group routes - /v1/device-groups
 *
 * Endpoints for managing device groups.
 */

import type { FastifyInstance } from 'fastify';

export async function groupRoutes(app: FastifyInstance) {
  /**
   * GET /v1/device-groups
   *
   * List Gateway groups and their accessible members.
   * Requires pairing:create scope.
   */
  app.get('/v1/device-groups', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const allowed = app.getAllowedDeviceIds(clientId);

    const groups = app.groupRepo.list(allowed);
    return reply.send({ groups });
  });
}