import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { parseRuntimeConfig } from '../../src/config/runtime-config.js';
import { encryptPayload, type Envelope } from '../../src/crypto/payload-crypto.js';
import { expectedSignature } from '../../src/crypto/request-signature.js';

const deviceId = 'test-device';
const token = 'test-api-token';
const secret = Buffer.alloc(32, 23);

describe('HTTP protocol integration', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'gateway-http-'));
    app = await buildApp({
      database: { path: join(tempDir, 'gateway.db') },
      runtimeConfig: runtimeConfig(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('verifies a pretty-printed event over the exact received bytes', async () => {
    const envelope = encryptedEvent('INCOMING_SMS', {
      originatingAddress: '+1000',
      body: 'ordinary message',
      partCount: 1,
      action: 'SMS_RECEIVED',
    });
    const rawBody = JSON.stringify(envelope, null, 2);
    const response = await signedPost('/v1/events', rawBody, 'nonce-pretty');

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ accepted: true, duplicate: false });
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toMatchObject({ count: 1 });
  });

  it('records an event nonce exactly once and rejects a real replay', async () => {
    const rawBody = JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { ok: true }));
    const first = await signedPost('/v1/events', rawBody, 'nonce-once');
    const replay = await signedPost('/v1/events', rawBody, 'nonce-once');

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: 'replayed nonce' });
  });

  it('rolls back nonce and event when a side effect is invalid', async () => {
    const invalidBody = JSON.stringify(encryptedEvent('DEVICE_STATE', {
      observedAt: 1,
      versionCode: 1,
      targetSdk: 37,
    }));
    const invalid = await signedPost('/v1/events', invalidBody, 'nonce-rollback');

    expect(invalid.statusCode).toBe(400);
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toMatchObject({ count: 0 });
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM request_nonces').get()).toMatchObject({ count: 0 });

    const validBody = JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { ok: true }));
    const retry = await signedPost('/v1/events', validBody, 'nonce-rollback');
    expect(retry.statusCode).toBe(201);
  });

  it('rejects unknown outbound status commands without persisting the event', async () => {
    const rawBody = JSON.stringify(encryptedEvent('OUTBOUND_SMS_STATUS', {
      commandId: 'unknown-command-id',
      status: 'DELIVERED',
      resultCode: null,
      errorDetail: null,
    }));
    const response = await signedPost('/v1/events', rawBody, 'nonce-unknown-command');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'unknown outbound command' });
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toMatchObject({ count: 0 });
  });

  it('verifies command claims over raw pretty-printed JSON', async () => {
    const rawBody = JSON.stringify({ limit: 5 }, null, 2);
    const response = await signedPost('/v1/device-commands/claim', rawBody, 'nonce-claim');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [] });
  });

  it('enforces configured API and authentication rate limits', async () => {
    await app.close();
    app = await buildApp({
      database: { path: join(tempDir, 'limited.db') },
      runtimeConfig: runtimeConfig({
        api_auth_requests_per_minute: 2,
        api_requests_per_minute: 1,
      }),
    });
    await app.ready();

    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: 'GET', url: '/v1/messages', headers });
    const second = await app.inject({ method: 'GET', url: '/v1/messages', headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('uses trusted proxy addresses for configured authentication limits', async () => {
    await rebuild('proxy.db', {
      trust_proxy_headers: true,
      api_auth_requests_per_minute: 1,
    });
    const request = (forwardedFor: string) => app.inject({
      method: 'GET',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer invalid',
        'x-forwarded-for': forwardedFor,
      },
    });

    expect((await request('203.0.113.1')).statusCode).toBe(401);
    expect((await request('203.0.113.1')).statusCode).toBe(429);
    expect((await request('203.0.113.2')).statusCode).toBe(401);
  });

  it('enforces configured ingestion IP and per-device limits', async () => {
    await rebuild('ingest-limited.db', {
      ingest_requests_per_minute: 1,
      device_requests_per_minute: 10,
    });
    const first = await signedPost('/v1/events', JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { n: 1 })), 'rate-1');
    const second = await signedPost('/v1/events', JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { n: 2 })), 'rate-2');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(429);

    await rebuild('device-limited.db', {
      ingest_requests_per_minute: 10,
      device_requests_per_minute: 1,
      trust_proxy_headers: true,
    });
    const deviceFirst = await signedPost(
      '/v1/events',
      JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { n: 1 })),
      'device-rate-1',
      { 'x-forwarded-for': '203.0.113.10' },
    );
    const deviceSecond = await signedPost(
      '/v1/events',
      JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { n: 2 })),
      'device-rate-2',
      { 'x-forwarded-for': '203.0.113.11' },
    );
    expect(deviceFirst.statusCode).toBe(201);
    expect(deviceSecond.statusCode).toBe(429);
  });

  it('enforces configured pairing create and claim limits', async () => {
    await rebuild('pairing-limited.db', {
      pairing_create_requests_per_minute: 1,
      pairing_claim_requests_per_minute: 1,
    });
    const create = () => app.inject({
      method: 'POST',
      url: '/v1/pairings',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ deviceId }),
    });
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(429);

    const claim = () => app.inject({
      method: 'POST',
      url: '/v1/pairings/claim',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pairingToken: 'x'.repeat(32) }),
    });
    expect((await claim()).statusCode).toBe(410);
    expect((await claim()).statusCode).toBe(429);
  });

  it('uses configured OTP age and retention settings', async () => {
    await rebuild('retention.db', {
      otp_max_age_seconds: 30,
      retention_days: 1,
    });
    const oldTime = Date.now() - 120_000;
    const oldOtp = encryptedEvent('INCOMING_SMS', { body: 'code 482913' }, oldTime);
    app.eventRepo.accept(deviceId, 'old-otp-event', 'old-otp-nonce', oldOtp, oldTime);

    const claim = await app.inject({
      method: 'POST',
      url: '/v1/otp/claim',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ deviceId }),
    });
    expect(claim.statusCode).toBe(404);

    app.db.prepare(`
      UPDATE events SET received_at = ? WHERE idempotency_key = ?
    `).run(Date.now() - 2 * 86_400_000, 'old-otp-event');
    const fresh = await signedPost(
      '/v1/events',
      JSON.stringify(encryptedEvent('LOCAL_SELF_TEST', { ok: true })),
      'retention-trigger',
    );
    expect(fresh.statusCode).toBe(201);
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?').get('old-otp-event')).toMatchObject({ count: 0 });
  });

  it('enforces the configured concurrent request ceiling', async () => {
    await app.close();
    app = await buildApp({
      database: { path: join(tempDir, 'concurrency.db') },
      runtimeConfig: runtimeConfig({ max_concurrent_requests: 1 }),
    });
    let releaseSlow: (() => void) | undefined;
    let enteredSlow: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredSlow = resolve; });
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    app.get('/test/slow', async () => {
      enteredSlow?.();
      await slow;
      return { ok: true };
    });
    await app.ready();

    const first = app.inject({ method: 'GET', url: '/test/slow' });
    await entered;
    const rejected = await app.inject({ method: 'GET', url: '/health' });
    expect(rejected.statusCode).toBe(429);
    releaseSlow?.();
    expect((await first).statusCode).toBe(200);
  });

  it.each([
    '/v1/messages?limit=0',
    '/v1/messages?limit=abc',
    '/v1/messages?limit=1x',
    '/v1/messages?afterId=1&afterId=2',
    '/v1/messages?afterId=1&beforeId=2',
    '/v1/outbound-messages?beforeId=0',
    '/v1/audit-log?limit=101',
  ])('rejects malformed query boundaries: %s', async url => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid query' });
  });

  it('loads pairing endpoint and certificate pin from server config', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/pairings',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ deviceId }),
    });

    expect(response.statusCode).toBe(201);
    const payload = JSON.parse(response.json().pairing.payload);
    expect(payload.endpoint).toBe('https://gateway.example.test');
    expect(payload.certificatePinSha256Base64).toBe(Buffer.alloc(32, 9).toString('base64'));
  });

  it('adds the production security headers to API responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  async function signedPost(
    url: string,
    rawBody: string,
    nonce: string,
    additionalHeaders: Record<string, string> = {},
  ) {
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
    return app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-gateway-device': deviceId,
        'x-gateway-timestamp': String(timestamp),
        'x-gateway-nonce': nonce,
        'x-gateway-signature': signature,
        'idempotency-key': idempotencyKey,
        ...additionalHeaders,
      },
      payload: rawBody,
    });
  }

  async function rebuild(databaseName: string, server: Record<string, unknown>): Promise<void> {
    await app.close();
    app = await buildApp({
      database: { path: join(tempDir, databaseName) },
      runtimeConfig: runtimeConfig(server),
    });
    await app.ready();
  }
});

function encryptedEvent(eventType: string, payload: Record<string, unknown>, createdAt = Date.now()) {
  const envelope: Envelope = {
    schemaVersion: 1,
    deliveryId: `delivery-${eventType.toLowerCase()}`,
    sourceEventId: `source-${eventType.toLowerCase()}`,
    eventType,
    createdAt,
    subscriptionId: 1,
    slotIndex: 0,
    payload,
  };
  return encryptPayload(envelope, deviceId, secret);
}

function runtimeConfig(server: Record<string, unknown> = {}) {
  return parseRuntimeConfig({
    devices: {
      [deviceId]: { secret_base64: secret.toString('base64') },
    },
    api_clients: {
      'test-client': {
        token_sha256: createHash('sha256').update(token).digest('hex'),
        scopes: ['*'],
      },
    },
    server: {
      pairing_public_endpoint: 'https://gateway.example.test',
      pairing_certificate_pin_sha256_base64: Buffer.alloc(32, 9).toString('base64'),
      ...server,
    },
  });
}
