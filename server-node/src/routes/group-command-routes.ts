/**
 * Group command routes - write operations for group management.
 *
 * POST /v1/device-groups - Create group
 * PUT /v1/device-groups/:groupId - Update group
 * DELETE /v1/device-groups/:groupId - Delete group
 */

import type { FastifyInstance } from 'fastify';
import { jsonObject } from '../http/body-validation.js';

export async function groupCommandRoutes(app: FastifyInstance) {
  /**
   * POST /v1/device-groups
   *
   * Create a Gateway group.
   * Requires pairing:create scope and global device access.
   */
  app.post('/v1/device-groups', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');

    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }

    const body = jsonObject(request.body);
    if (!body) return reply.status(400).send({ error: 'invalid request' });
    const allowedKeys = new Set(['groupId', 'name', 'deviceIds']);
    if (new Set(Object.keys(body)).size !== allowedKeys.size || !Object.keys(body).every(k => allowedKeys.has(k))) {
      return reply.status(400).send({ error: 'invalid request fields' });
    }

    const groupId = body.groupId;
    const name = body.name;
    const deviceIds = body.deviceIds;

    if (typeof groupId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) {
      return reply.status(400).send({ error: 'invalid groupId' });
    }
    if (typeof name !== 'string') {
      return reply.status(400).send({ error: 'invalid name' });
    }
    if (!Array.isArray(deviceIds) || !deviceIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id))) {
      return reply.status(400).send({ error: 'invalid deviceIds' });
    }

    try {
      const nowMs = Date.now();
      const knownDevices = new Set(app.deviceSecrets.keys());
      const group = app.groupRepo.create(groupId, name, deviceIds as string[], nowMs, knownDevices);

      app.auditRepo.record(clientId, 'DEVICE_GROUP_CREATE', null, 'SUCCESS', {
        groupId,
        deviceCount: deviceIds.length,
      });

      return reply.status(201).send({ group });
    } catch (error: any) {
      if (error.message === 'group already exists') {
        return reply.status(409).send({ error: error.message });
      }
      if ([
        'invalid groupId',
        'invalid group name',
        'duplicate deviceId',
        'unknown deviceId',
      ].includes(error.message)) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * PUT /v1/device-groups/:groupId
   *
   * Rename a Gateway group or replace its members.
   * Requires pairing:create scope and global device access.
   */
  app.put('/v1/device-groups/:groupId', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { groupId } = request.params as { groupId: string };

    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }

    const body = jsonObject(request.body);
    if (!body) return reply.status(400).send({ error: 'invalid request' });
    const allowedKeys = new Set(['name', 'deviceIds']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'invalid request fields' });
      }
    }
    if (Object.keys(body).length === 0) {
      return reply.status(400).send({ error: 'invalid request fields' });
    }

    const name = body.name;
    const deviceIds = body.deviceIds;

    if (name !== undefined && typeof name !== 'string') {
      return reply.status(400).send({ error: 'invalid name' });
    }
    if (deviceIds !== undefined) {
      if (!Array.isArray(deviceIds) || !deviceIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id))) {
        return reply.status(400).send({ error: 'invalid deviceIds' });
      }
    }

    try {
      const nowMs = Date.now();
      const knownDevices = new Set(app.deviceSecrets.keys());
      const group = app.groupRepo.update(groupId, name as string | undefined, deviceIds as string[] | undefined, nowMs, knownDevices);

      if (!group) {
        return reply.status(404).send({ error: 'device group not found' });
      }

      app.auditRepo.record(clientId, 'DEVICE_GROUP_UPDATE', null, 'SUCCESS', { groupId });
      return reply.send({ group });
    } catch (error: any) {
      if ([
        'invalid group name',
        'duplicate deviceId',
        'unknown deviceId',
      ].includes(error.message)) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * DELETE /v1/device-groups/:groupId
   *
   * Delete a Gateway group without deleting its devices.
   * Requires pairing:create scope and global device access.
   */
  app.delete('/v1/device-groups/:groupId', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const { groupId } = request.params as { groupId: string };

    if (app.getAllowedDeviceIds(clientId) !== null) {
      return reply.status(403).send({ error: 'global device access required' });
    }

    const deleted = app.groupRepo.delete(groupId);
    if (!deleted) {
      return reply.status(404).send({ error: 'device group not found' });
    }

    app.auditRepo.record(clientId, 'DEVICE_GROUP_DELETE', null, 'SUCCESS', { groupId });
    return reply.send({ deleted: true });
  });
}
