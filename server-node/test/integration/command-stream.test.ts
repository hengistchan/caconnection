import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { parseRuntimeConfig } from '../../src/config/runtime-config.js';
import { expectedSignature } from '../../src/crypto/request-signature.js';

const deviceId = 'stream-device';
const token = 'stream-api-token';
const secret = Buffer.alloc(32, 41);
const recipient = '+15551234567';
const messageBody = 'command stream payload';

describe('command stream integration', () => {
  let app: FastifyInstance;
  let tempDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'gateway-stream-'));
    app = await buildApp({
      database: { path: join(tempDir, 'gateway.db') },
      runtimeConfig: runtimeConfig(),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP listen address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('nudges connected streams when a command is queued, without leaking content', async () => {
    const stream = await openStream('nonce-live');
    try {
      await queueCommand('idempotency-live-01');

      const frame = await stream.readUntil('event: command_queued');
      expect(frame).toContain(`"deviceId":"${deviceId}"`);
      expect(frame).toContain('"pending":1');
      // ADR-003: the nudge is advisory — command content travels only
      // through claim.
      expect(frame).not.toContain(recipient);
      expect(frame).not.toContain(messageBody);
    } finally {
      stream.close();
    }
  });

  it('emits a connect-time snapshot when work was queued while offline', async () => {
    await queueCommand('idempotency-snap-01');

    const stream = await openStream('nonce-snap');
    try {
      const frame = await stream.readUntil('event: command_queued');
      expect(frame).toContain('"pending":1');
    } finally {
      stream.close();
    }
  });

  it('still delivers command content only through claim', async () => {
    await queueCommand('idempotency-claim-01');

    const claim = await signedPost('/v1/device-commands/claim', '{"limit":5}', 'nonce-claim');
    expect(claim.status).toBe(200);
    const commands = (await claim.json()).commands;
    expect(commands).toHaveLength(1);
    expect(commands[0].recipient).toBe(recipient);
    expect(commands[0].body).toBe(messageBody);
  });

  it('rejects unsigned and mis-bodied stream requests', async () => {
    const unsigned = await fetch(`${baseUrl}/v1/device-commands/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: 'commands' }),
    });
    expect(unsigned.status).toBe(401);
    await unsigned.text();

    const wrongTopic = await signedPost(
      '/v1/device-commands/stream',
      JSON.stringify({ stream: 'everything' }),
      'nonce-bad-topic',
    );
    expect(wrongTopic.status).toBe(400);
    await wrongTopic.text();

    const unknownField = await signedPost(
      '/v1/device-commands/stream',
      JSON.stringify({ stream: 'commands', limit: 5 }),
      'nonce-bad-field',
    );
    expect(unknownField.status).toBe(400);
    await unknownField.text();
  });

  async function queueCommand(idempotencyKey: string) {
    const response = await fetch(`${baseUrl}/v1/outbound-messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        deviceId,
        slotIndex: 0,
        recipient,
        body: messageBody,
        expiresInSeconds: 3600,
        idempotencyKey,
      }),
    });
    expect(response.status).toBe(201);
    await response.text();
  }

  async function openStream(nonce: string) {
    const rawBody = JSON.stringify({ stream: 'commands' });
    const timestamp = Date.now();
    const idempotencyKey = `idem-${nonce}`;
    const signature = expectedSignature(
      secret,
      timestamp,
      nonce,
      deviceId,
      idempotencyKey,
      Buffer.from(rawBody),
    );
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/device-commands/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-device': deviceId,
        'x-gateway-timestamp': String(timestamp),
        'x-gateway-nonce': nonce,
        'x-gateway-signature': signature,
        'idempotency-key': idempotencyKey,
      },
      body: rawBody,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    return {
      async readUntil(needle: string, timeoutMs = 5_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        while (!buffered.includes(needle)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error(`timed out waiting for ${needle}; saw: ${buffered}`);
          }
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`timed out waiting for ${needle}; saw: ${buffered}`)),
                remaining,
              );
            }),
          ]);
          if (chunk.done) throw new Error(`stream ended before ${needle}; saw: ${buffered}`);
          buffered += decoder.decode(chunk.value, { stream: true });
        }
        return buffered;
      },
      close() {
        controller.abort();
      },
    };
  }

  async function signedPost(url: string, rawBody: string, nonce: string) {
    const timestamp = Date.now();
    const idempotencyKey = `idem-${nonce}`;
    const signature = expectedSignature(
      secret,
      timestamp,
      nonce,
      deviceId,
      idempotencyKey,
      Buffer.from(rawBody),
    );
    return fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-device': deviceId,
        'x-gateway-timestamp': String(timestamp),
        'x-gateway-nonce': nonce,
        'x-gateway-signature': signature,
        'idempotency-key': idempotencyKey,
      },
      body: rawBody,
    });
  }
});

function runtimeConfig() {
  return parseRuntimeConfig({
    devices: {
      [deviceId]: { secret_base64: secret.toString('base64') },
    },
    api_clients: {
      'stream-client': {
        token_sha256: createHash('sha256').update(token).digest('hex'),
        scopes: ['*'],
      },
    },
    server: {
      pairing_public_endpoint: 'https://gateway.example.test',
      pairing_certificate_pin_sha256_base64: Buffer.alloc(32, 9).toString('base64'),
    },
  });
}
