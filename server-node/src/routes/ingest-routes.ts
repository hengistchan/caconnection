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

  /**
   * POST /v1/device-commands/stream — server-sent events command nudge.
   *
   * Advisory only (ADR-003): frames say "commands are queued", never what
   * they are. The device reacts by claiming over the normal claim endpoint,
   * which stays the only place commands are marked CLAIMED and their content
   * leaves the server. POST with a signed body reuses the device
   * authenticator unchanged — a GET stream would need a second signing scheme.
   */
  app.post('/v1/device-commands/stream', async (request, reply) => {
    const auth = app.deviceAuthenticator.authenticate(request, 'device-auth-ip', 'device');
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ error: 'invalid request' });
    }
    const allowedKeys = new Set(['stream']);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) {
      return reply.status(400).send({ error: 'invalid request' });
    }
    if ((body as Record<string, unknown>).stream !== 'commands') {
      return reply.status(400).send({ error: 'invalid request' });
    }

    app.deviceRepo.touchDevice(auth.deviceId, auth.nowMs);

    reply.hijack();
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Reverse proxies must not batch these frames behind a buffer.
      'x-accel-buffering': 'no',
    };
    reply.raw.writeHead(200, headers);

    let closed = false;
    const write = (frame: string) => {
      if (closed || reply.raw.writableEnded) return;
      reply.raw.write(frame);
    };

    // Client reconnect pacing hint; the client also runs its own backoff.
    write('retry: 15000\n\n');

    const unsubscribe = app.commandStreamHub.subscribe(auth.deviceId, event => {
      write(`event: command_queued\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Connect-time snapshot: work queued while this stream was down (or
    // before it existed) must not wait for the reconcile poll.
    const pending = app.outboundRepo.countQueued(auth.deviceId, auth.nowMs);
    if (pending > 0) {
      write(
        `event: command_queued\ndata: ${JSON.stringify({
          deviceId: auth.deviceId,
          queuedAt: auth.nowMs,
          pending,
        })}\n\n`,
      );
    }

    // Heartbeat keeps intermediaries from closing an idle stream and lets
    // the client detect a half-open connection.
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      detachStream();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const detachStream = app.commandStreamHub.attachStream(cleanup);
    // Only the response socket is a safe teardown signal here: on a POST,
    // request.raw emits 'close' as soon as the request body is consumed —
    // listening to it would end the stream the moment it opens.
    reply.raw.on('close', cleanup);
  });
}
