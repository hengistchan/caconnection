/**
 * OTP routes - /v1/otp/claim
 *
 * Endpoint for atomically claiming the newest unclaimed OTP.
 */

import type { FastifyInstance } from 'fastify';
import { jsonObject } from '../http/body-validation.js';

export async function otpRoutes(app: FastifyInstance) {
  /**
   * POST /v1/otp/claim
   *
   * Atomically claim the newest unclaimed OTP.
   * Requires otp:claim scope.
   */
  app.post('/v1/otp/claim', async (request, reply) => {
    const clientId = app.verifyApi(request, 'otp:claim');
    const body = jsonObject(request.body);
    if (!body) return reply.status(400).send({ error: 'invalid request' });

    const allowedKeys = new Set(['deviceId', 'slotIndex', 'maxAgeSeconds', 'eventId']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'unsupported request field' });
      }
    }

    const deviceId = body.deviceId;
    const slotIndex = body.slotIndex;
    const maxAgeSeconds = body.maxAgeSeconds ?? app.runtimeConfig.server.otpMaxAgeSeconds;
    const eventId = body.eventId;

    // Validate deviceId
    if (deviceId !== undefined) {
      if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
        return reply.status(400).send({ error: 'invalid deviceId' });
      }
    }

    // Validate slotIndex
    if (slotIndex !== undefined) {
      if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex) || (slotIndex !== 0 && slotIndex !== 1)) {
        return reply.status(400).send({ error: 'invalid slotIndex' });
      }
    }

    // Validate maxAgeSeconds
    if (typeof maxAgeSeconds !== 'number' || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 30 || maxAgeSeconds > 3600) {
      return reply.status(400).send({ error: 'invalid maxAgeSeconds' });
    }

    // Validate eventId
    if (eventId !== undefined) {
      if (typeof eventId !== 'number' || !Number.isInteger(eventId) || eventId < 1) {
        return reply.status(400).send({ error: 'invalid eventId' });
      }
    }

    // deviceId is required for latest OTP claims
    if (eventId === undefined && deviceId === undefined) {
      return reply.status(400).send({ error: 'deviceId is required for latest OTP claims' });
    }

    // Check device access
    if (deviceId !== undefined && !app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    const secrets = app.getClientSecrets(clientId);
    const nowMs = Date.now();

    const claimed = app.otpRepo.claimLatest(secrets, clientId, nowMs, maxAgeSeconds, {
      slotIndex: slotIndex as number | undefined,
      eventId: eventId as number | undefined,
      deviceId: deviceId as string | undefined,
      deviceIds: deviceId === undefined ? app.getAllowedDeviceIds(clientId) ?? undefined : undefined,
    });

    if (!claimed) {
      return reply.status(404).send({ error: 'no unclaimed OTP found' });
    }

    return reply.send({ otp: claimed });
  });
}
