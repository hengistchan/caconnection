import type { FastifyRequest } from 'fastify';
import { MAX_BODY_BYTES, MAX_CLOCK_SKEW_MS } from '../config/constants.js';
import type { ServerSettings } from '../config/runtime-config.js';
import { verifySignature } from '../crypto/request-signature.js';
import type { DeviceRepository } from '../repositories/device-repository.js';
import type { SlidingWindowRateLimiter } from '../auth/rate-limiter.js';
import { AuthenticationError, RateLimitError } from '../auth/auth-errors.js';

export interface AuthenticatedDeviceRequest {
  deviceId: string;
  secret: Buffer;
  nonce: string;
  idempotencyKey: string;
  timestampMs: number;
  nowMs: number;
  body: Buffer;
}

export class DeviceRequestAuthenticator {
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly deviceSecrets: Map<string, Buffer>,
    private readonly rateLimiter: SlidingWindowRateLimiter,
    private readonly settings: ServerSettings,
  ) {}

  authenticate(
    request: FastifyRequest,
    ipBucket: 'ingest-ip' | 'device-auth-ip',
    deviceBucket: 'ingest-device' | 'device',
  ): AuthenticatedDeviceRequest {
    const initialNow = Date.now();
    const ipLimit = this.rateLimiter.allow(
      ipBucket,
      request.ip,
      this.settings.ingestRequestsPerMinute,
      initialNow,
    );
    if (!ipLimit.allowed) {
      throw new RateLimitError(ipLimit.retryAfterMs);
    }

    const body = request.rawBody;
    if (!body || body.length === 0 || body.length > MAX_BODY_BYTES) {
      const error = new Error('invalid body size') as Error & { statusCode: number };
      error.statusCode = body && body.length > MAX_BODY_BYTES ? 413 : 400;
      throw error;
    }

    const deviceId = header(request, 'x-gateway-device');
    const nonce = header(request, 'x-gateway-nonce');
    const idempotencyKey = header(request, 'idempotency-key');
    const signature = header(request, 'x-gateway-signature');
    const timestampRaw = header(request, 'x-gateway-timestamp');
    if (!timestampRaw || !/^[+-]?\d+$/.test(timestampRaw)) {
      throw new AuthenticationError('invalid timestamp');
    }
    const timestampMs = Number(timestampRaw);
    if (!Number.isSafeInteger(timestampMs)) {
      throw new AuthenticationError('invalid timestamp');
    }

    const secret = this.deviceSecrets.get(deviceId);
    const nowMs = Date.now();
    if (
      !secret
      || !this.deviceRepo.isActive(deviceId)
      || nonce.length < 1
      || nonce.length > 128
      || idempotencyKey.length < 1
      || idempotencyKey.length > 128
      || signature.length < 1
      || signature.length > 128
      || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS
    ) {
      throw new AuthenticationError('authentication failed');
    }
    if (!verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)) {
      throw new AuthenticationError('authentication failed');
    }

    const deviceLimit = this.rateLimiter.allow(
      deviceBucket,
      deviceId,
      this.settings.deviceRequestsPerMinute,
      nowMs,
    );
    if (!deviceLimit.allowed) {
      throw new RateLimitError(deviceLimit.retryAfterMs);
    }

    return { deviceId, secret, nonce, idempotencyKey, timestampMs, nowMs, body };
  }
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}
