/**
 * Signed Android-device protocol endpoints.
 *
 * Signature verification is deliberately performed over request.rawBody.
 * Never reconstruct these bytes from the parsed JSON value.
 */

import type { FastifyInstance } from 'fastify';
import { decryptPayload } from '../crypto/payload-crypto.js';
import {
  InvalidEventPayloadError,
  rethrowOperationalError,
} from '../http/operational-errors.js';
import { validateEnvelope } from '../protocol/envelope.js';

export async function ingestRoutes(app: FastifyInstance) {
  app.post('/v1/events', async (request, reply) => {
    const auth = app.deviceAuthenticator.authenticate(request, 'ingest-ip', 'ingest-device', {
      // The ingestion service records the nonce in the same transaction as
      // the event insert — a "replayed nonce" 409 must always correspond to
      // an event that is already stored.
      deferNonceRecording: true,
    });

    let envelope;
    let decryptedPayload: Record<string, unknown>;
    try {
      envelope = validateEnvelope(request.body);
      if (envelope.schemaVersion !== 2) {
        throw new Error('encrypted schemaVersion 2 required');
      }
      const decrypted = decryptPayload(envelope, auth.deviceId, auth.secret);
      decryptedPayload = decrypted.payload as Record<string, unknown>;
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'invalid request',
      });
    }

    try {
      const inserted = app.eventIngestionService.accept(
        auth.deviceId,
        auth.idempotencyKey,
        auth.nonce,
        envelope,
        decryptedPayload,
        auth.nowMs,
      );
      if (inserted) app.notificationDispatcher?.wake();
      return reply.status(inserted ? 201 : 200).send({
        accepted: true,
        duplicate: !inserted,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid request';
      if (message === 'replayed nonce') {
        return reply.status(409).send({ error: message });
      }
      if (error instanceof InvalidEventPayloadError) {
        throw error;
      }
      rethrowOperationalError(error);
    }
  });

  app.post('/v1/device-commands/claim', async (request, reply) => {
    const auth = app.deviceAuthenticator.authenticate(request, 'device-auth-ip', 'device');
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ error: 'invalid request' });
    }

    const allowedKeys = new Set(['limit']);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) {
      return reply.status(400).send({ error: 'invalid request' });
    }
    const limitValue = (body as Record<string, unknown>).limit;
    const limit = limitValue === undefined ? 5 : limitValue;
    if (
      typeof limit !== 'number'
      || !Number.isInteger(limit)
      || limit < 1
      || limit > 10
    ) {
      return reply.status(400).send({ error: 'invalid limit' });
    }

    try {
      // Nonce recording happens in authenticate() — a duplicate request must
      // fail there with 409 before any claim side effects run.
      app.deviceRepo.touchDevice(auth.deviceId, auth.nowMs);
      const commands = app.outboundRepo.claim(
        auth.deviceId,
        auth.secret,
        limit,
        auth.nowMs,
      );
      return reply.send({ commands });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid request';
      if (message === 'replayed nonce') {
        return reply.status(409).send({ error: message });
      }
      rethrowOperationalError(error);
    }
  });
}
