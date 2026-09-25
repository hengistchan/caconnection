/**
 * Device routes - /v1/devices, /v1/devices/detail
 *
 * Endpoints for listing and managing devices.
 */

import type { FastifyInstance } from 'fastify';

export async function deviceRoutes(app: FastifyInstance) {
  /**
   * GET /v1/devices
   *
   * List configured device IDs available for pairing.
   * Requires devices:read scope.
   */
  app.get('/v1/devices', async (request, reply) => {
    const clientId = app.verifyApi(request, 'devices:read');
    const secrets = app.getClientSecrets(clientId);

    const devices = [...secrets.keys()]
      .filter(deviceId => app.deviceRepo.isActive(deviceId))
      .sort();

    return reply.send({ devices });
  });

  /**
   * GET /v1/devices/detail
   *
   * List gateway device metadata without exposing secrets.
   * Requires devices:read scope.
   */
  app.get('/v1/devices/detail', async (request, reply) => {
    const clientId = app.verifyApi(request, 'devices:read');
    const allowed = app.getAllowedDeviceIds(clientId);

    const allDevices = app.deviceRepo.getAll();
    const devices = allowed === null
      ? allDevices
      : allDevices.filter(d => allowed.has(d.deviceId));

    return reply.send({ devices });
  });
}