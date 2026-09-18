/**
 * Pairing routes - /v1/pairings, /v1/pairings/claim
 *
 * Endpoints for device pairing.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  MIN_PAIRING_EXPIRES_SECONDS,
  MAX_PAIRING_EXPIRES_SECONDS,
} from '../config/constants.js';

export async function pairingRoutes(app: FastifyInstance) {
  /**
   * POST /v1/pairings
   *
   * Create a short-lived Android pairing QR payload.
   * Requires pairing:create scope.
   */
  app.post('/v1/pairings', async (request, reply) => {
    const clientId = app.verifyApi(request, 'pairing:create');
    const body = request.body as Record<string, unknown>;

    const allowedKeys = new Set(['deviceId', 'expiresInSeconds']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'unsupported request field' });
      }
    }

    const deviceId = body.deviceId;
    const expiresInSeconds = body.expiresInSeconds ?? 300;

    if (typeof deviceId !== 'string' || !app.deviceSecrets.has(deviceId) || !app.deviceRepo.isActive(deviceId)) {
      return reply.status(400).send({ error: 'invalid deviceId' });
    }
    if (typeof expiresInSeconds !== 'number' || expiresInSeconds < MIN_PAIRING_EXPIRES_SECONDS || expiresInSeconds > MAX_PAIRING_EXPIRES_SECONDS) {
      return reply.status(400).send({ error: 'invalid expiresInSeconds' });
    }

    if (!app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    // Check pairing is configured
    const pairingEndpoint = process.env.PAIRING_PUBLIC_ENDPOINT || '';
    if (!pairingEndpoint) {
      return reply.status(503).send({ error: 'pairing unavailable' });
    }

    try {
      const token = randomBytes(24).toString('base64url');
      const nowMs = Date.now();
      const expiresAt = app.pairingRepo.create(token, deviceId, nowMs, expiresInSeconds);

      const document: Record<string, unknown> = {
        schemaVersion: 1,
        type: 'ca-connection-pairing',
        endpoint: pairingEndpoint,
        pairingToken: token,
      };

      const certPin = process.env.PAIRING_CERTIFICATE_PIN || '';
      if (certPin) {
        document.certificatePinSha256Base64 = certPin;
      }

      app.auditRepo.record(clientId, 'PAIRING_CREATE', deviceId, 'SUCCESS', { expiresInSeconds });

      return reply.status(201).send({
        pairing: {
          deviceId,
          expiresAt,
          payload: JSON.stringify(document),
        },
      });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message || 'invalid request' });
    }
  });

  /**
   * POST /v1/pairings/claim
   *
   * Atomically exchange a one-time pairing token for provisioning.
   */
  app.post('/v1/pairings/claim', async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    if (Object.keys(body).length !== 1 || !body.pairingToken) {
      return reply.status(400).send({ error: 'invalid request fields' });
    }

    const token = body.pairingToken;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      return reply.status(400).send({ error: 'invalid pairing token' });
    }

    const nowMs = Date.now();
    const deviceId = app.pairingRepo.claim(token, nowMs);
    const secret = deviceId ? app.deviceSecrets.get(deviceId) : undefined;

    if (!deviceId || !secret || !app.deviceRepo.isActive(deviceId)) {
      return reply.status(410).send({ error: 'pairing expired or already used' });
    }

    const pairingEndpoint = process.env.PAIRING_PUBLIC_ENDPOINT || '';
    const certPin = process.env.PAIRING_CERTIFICATE_PIN || null;

    return reply.send({
      provisioning: {
        schemaVersion: 1,
        endpoint: pairingEndpoint,
        deviceId,
        sharedSecretBase64: secret.toString('base64'),
        certificatePinSha256Base64: certPin,
        enabled: true,
      },
    });
  });
}