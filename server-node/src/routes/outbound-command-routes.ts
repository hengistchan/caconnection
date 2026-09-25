/**
 * Outbound command routes - POST /v1/outbound-messages
 *
 * Endpoint for queuing outbound SMS commands.
 */

import type { FastifyInstance } from 'fastify';
import { jsonObject } from '../http/body-validation.js';
import {
  MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS,
  MAX_OUTBOUND_COMMAND_EXPIRES_SECONDS,
  DEFAULT_OUTBOUND_COMMAND_EXPIRES_SECONDS,
} from '../config/constants.js';

export async function outboundCommandRoutes(app: FastifyInstance) {
  /**
   * POST /v1/outbound-messages
   *
   * Queue an outbound SMS command for an Android gateway.
   * Requires messages:send scope.
   */
  app.post('/v1/outbound-messages', async (request, reply) => {
    const clientId = app.verifyApi(request, 'messages:send');
    const body = jsonObject(request.body);
    if (!body) return reply.status(400).send({ error: 'invalid request' });

    const allowedKeys = new Set(['deviceId', 'slotIndex', 'recipient', 'body', 'expiresInSeconds', 'idempotencyKey']);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return reply.status(400).send({ error: 'unsupported request field' });
      }
    }

    const deviceId = body.deviceId;
    const slotIndex = body.slotIndex;
    const recipient = body.recipient;
    const messageBody = body.body;
    const expiresInSeconds = body.expiresInSeconds ?? DEFAULT_OUTBOUND_COMMAND_EXPIRES_SECONDS;
    const idempotencyKey = body.idempotencyKey;

    // Access check first: distinguishing "not yours" (403) from "not found"
    // (400) would let scoped clients enumerate global device ids.
    if (typeof deviceId !== 'string' || !app.verifyDeviceAccess(clientId, deviceId)) {
      return reply.status(403).send({ error: 'device access denied' });
    }

    // Validate deviceId
    if (!app.deviceSecrets.has(deviceId) || !app.deviceRepo.isActive(deviceId)) {
      return reply.status(400).send({ error: 'invalid deviceId' });
    }

    // Validate slotIndex
    if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex) || (slotIndex !== 0 && slotIndex !== 1)) {
      return reply.status(400).send({ error: 'invalid slotIndex' });
    }

    // Validate recipient
    if (typeof recipient !== 'string' || recipient.trim().length < 1 || recipient.trim().length > 64 || /[A-Za-z]/.test(recipient)) {
      return reply.status(400).send({ error: 'invalid recipient' });
    }

    // Validate body
    if (typeof messageBody !== 'string' || messageBody.length < 1 || messageBody.length > 2000) {
      return reply.status(400).send({ error: 'invalid body' });
    }

    // Validate expiresInSeconds
    if (typeof expiresInSeconds !== 'number' || !Number.isInteger(expiresInSeconds) || expiresInSeconds < MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS || expiresInSeconds > MAX_OUTBOUND_COMMAND_EXPIRES_SECONDS) {
      return reply.status(400).send({ error: 'invalid expiresInSeconds' });
    }

    // Validate idempotencyKey
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{16,128}$/.test(idempotencyKey)) {
      return reply.status(400).send({ error: 'invalid idempotencyKey' });
    }

    try {
      const nowMs = Date.now();
      const secret = app.deviceSecrets.get(deviceId)!;
      const command = app.outboundRepo.create(
        deviceId,
        secret,
        slotIndex,
        recipient.trim(),
        messageBody,
        idempotencyKey,
        nowMs,
        expiresInSeconds,
      );

      // Latency nudge only (ADR-003): a connected gateway claims within
      // milliseconds instead of waiting for its reconcile poll. An
      // idempotent retry may nudge again — the extra claim is empty and
      // harmless, and command content still travels only via claim.
      app.commandStreamHub.notifyQueued({
        deviceId,
        queuedAt: nowMs,
        pending: app.outboundRepo.countQueued(deviceId, nowMs),
      });

      app.auditRepo.record(clientId, 'OUTBOUND_SMS_QUEUE', deviceId, 'SUCCESS', {
        slotIndex,
        expiresInSeconds,
      });

      return reply.status(201).send({ outboundMessage: command });
    } catch (error: any) {
      if (error.message === 'idempotency key conflict') {
        return reply.status(409).send({ error: 'idempotency conflict' });
      }
      throw error;
    }
  });
}
