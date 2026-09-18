/**
 * Device command routes - write operations for device management.
 *
 * POST /v1/devices - Create device
 * PUT /v1/devices/:deviceId - Update device
 * DELETE /v1/devices/:deviceId - Retire device
 * POST /v1/devices/:deviceId/restore - Restore device
 * POST /v1/devices/:deviceId/purge - Purge device
 */

import type { FastifyInstance } from 'fastify';

export async function deviceCommandRoutes(app: FastifyInstance) {
  /**
   * POST /v1/devices
   *
   * Add a gateway device.
   * Requires pairing:create scope.
   */
  app.post('/v1/devices', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const body = request.body as Record<string, unknown>;

    const allowedKeys = new Set(['deviceId', 'secretBase64', 'description']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'unsupported request field' });
      }
    }

    const deviceId = body.deviceId;
    const secretBase64 = body.secretBase64;
    const description = body.description || '';

    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      return reply.status(400).send({ error: 'deviceId is required' });
    }
    if (typeof secretBase64 !== 'string' || !secretBase64) {
      return reply.status(400).send({ error: 'secretBase64 is required' });
    }
    if (typeof description !== 'string') {
      return reply.status(400).send({ error: 'description must be a string' });
    }

    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    try {
      const nowMs = Date.now();
      const device = app.deviceRepo.add(deviceId, secretBase64, description, nowMs);

      // Reload device secrets
      const newSecrets = app.deviceRepo.loadSecrets();
      app.deviceSecrets.clear();
      for (const [k, v] of newSecrets) {
        app.deviceSecrets.set(k, v);
      }

      app.auditRepo.record(clientId, 'DEVICE_CREATE', deviceId, 'SUCCESS');
      return reply.status(201).send({ device });
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        return reply.status(409).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message || 'invalid request' });
    }
  });

  /**
   * PUT /v1/devices/:deviceId
   *
   * Update a device description or rotate its shared secret.
   * Requires pairing:create scope.
   */
  app.put('/v1/devices/:deviceId', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { deviceId } = request.params as { deviceId: string };

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      return reply.status(400).send({ error: 'invalid device_id' });
    }
    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const body = request.body as Record<string, unknown>;
    const allowedKeys = new Set(['description', 'secretBase64']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'unsupported request field' });
      }
    }
    if (Object.keys(body).length === 0) {
      return reply.status(400).send({ error: 'empty request' });
    }

    const description = body.description;
    const secretBase64 = body.secretBase64;

    if (description !== undefined && typeof description !== 'string') {
      return reply.status(400).send({ error: 'description must be a string' });
    }
    if (secretBase64 !== undefined && typeof secretBase64 !== 'string') {
      return reply.status(400).send({ error: 'secretBase64 must be a string' });
    }

    try {
      const device = app.deviceRepo.update(deviceId, description as string | undefined, secretBase64 as string | undefined);
      if (!device) {
        return reply.status(404).send({ error: 'device not found' });
      }

      if (secretBase64) {
        const _newSecrets = app.deviceRepo.loadSecrets(); app.deviceSecrets.clear(); for (const [k, v] of _newSecrets) { app.deviceSecrets.set(k, v); }
      }

      app.auditRepo.record(clientId, 'DEVICE_UPDATE', deviceId, 'SUCCESS', {
        descriptionChanged: description !== undefined,
        secretRotated: secretBase64 !== undefined,
      });

      return reply.send({ device });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message || 'invalid request' });
    }
  });

  /**
   * DELETE /v1/devices/:deviceId
   *
   * Retire a gateway device.
   * Requires pairing:create scope.
   */
  app.delete('/v1/devices/:deviceId', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { deviceId } = request.params as { deviceId: string };

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      return reply.status(400).send({ error: 'invalid device_id' });
    }
    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const nowMs = Date.now();
    const retired = app.deviceRepo.retire(deviceId, nowMs);
    if (!retired) {
      return reply.status(404).send({ error: 'device not found' });
    }

    const _newSecrets = app.deviceRepo.loadSecrets(); app.deviceSecrets.clear(); for (const [k, v] of _newSecrets) { app.deviceSecrets.set(k, v); }
    app.auditRepo.record(clientId, 'DEVICE_RETIRE', deviceId, 'SUCCESS');

    return reply.send({ retired: true, device: app.deviceRepo.getById(deviceId) });
  });

  /**
   * POST /v1/devices/:deviceId/restore
   *
   * Restore a retired gateway device.
   * Requires pairing:create scope.
   */
  app.post('/v1/devices/:deviceId/restore', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { deviceId } = request.params as { deviceId: string };

    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const body = request.body as Record<string, unknown>;
    if (Object.keys(body).length > 0) {
      return reply.status(400).send({ error: 'empty request required' });
    }

    const restored = app.deviceRepo.restore(deviceId);
    if (!restored) {
      return reply.status(404).send({ error: 'device not found' });
    }

    const _newSecrets = app.deviceRepo.loadSecrets(); app.deviceSecrets.clear(); for (const [k, v] of _newSecrets) { app.deviceSecrets.set(k, v); }
    app.auditRepo.record(clientId, 'DEVICE_RESTORE', deviceId, 'SUCCESS');

    return reply.send({ device: app.deviceRepo.getById(deviceId) });
  });

  /**
   * POST /v1/devices/:deviceId/purge
   *
   * Irreversibly purge a gateway and all associated data.
   * Requires pairing:create scope.
   */
  app.post('/v1/devices/:deviceId/purge', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { deviceId } = request.params as { deviceId: string };

    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const body = request.body as Record<string, unknown>;
    if (body.confirmation !== `PURGE ${deviceId}`) {
      return reply.status(400).send({ error: 'confirmation required' });
    }

    const purged = app.deviceRepo.purge(deviceId);
    if (!purged) {
      return reply.status(404).send({ error: 'device not found' });
    }

    const _newSecrets = app.deviceRepo.loadSecrets(); app.deviceSecrets.clear(); for (const [k, v] of _newSecrets) { app.deviceSecrets.set(k, v); }
    app.auditRepo.record(clientId, 'DEVICE_PURGE', deviceId, 'SUCCESS');

    return reply.send({ purged: true });
  });
}