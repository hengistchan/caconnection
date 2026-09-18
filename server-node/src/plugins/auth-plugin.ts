/**
 * Fastify authentication plugin.
 *
 * Adds device and API client authentication helpers to the Fastify instance.
 */

import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { SlidingWindowRateLimiter } from '../auth/rate-limiter.js';
import { DeviceRepository } from '../repositories/device-repository.js';
import {
  verifyApiClient,
  type ApiClient,
} from '../auth/api-client-auth.js';
import {
  parseDeviceAuthHeaders,
  verifyDeviceRequest,
} from '../auth/device-auth.js';
import { AuthenticationError, AuthorizationError, RateLimitError } from '../auth/auth-errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    rateLimiter: SlidingWindowRateLimiter;
    deviceRepo: DeviceRepository;
    apiClients: Map<string, ApiClient>;
    deviceSecrets: Map<string, Buffer>;
    verifyApi: (request: FastifyRequest, requiredScope: string) => string;
    verifyDevice: (request: FastifyRequest, body: Buffer) => { deviceId: string; secret: Buffer };
  }
}

export interface AuthPluginOptions {
  apiClients: Map<string, ApiClient>;
  deviceSecrets: Map<string, Buffer>;
  rateLimits: {
    ingestPerMinute: number;
    devicePerMinute: number;
    apiAuthPerMinute: number;
    apiPerMinute: number;
    pairingCreatePerMinute: number;
    pairingClaimPerMinute: number;
  };
}

export default fp<AuthPluginOptions>(async function authPlugin(app, options) {
  const rateLimiter = new SlidingWindowRateLimiter();
  const deviceRepo = new DeviceRepository(app.db);

  app.decorate('rateLimiter', rateLimiter);
  app.decorate('deviceRepo', deviceRepo);
  app.decorate('apiClients', options.apiClients);
  app.decorate('deviceSecrets', options.deviceSecrets);

  /**
   * Verify API client authentication.
   */
  app.decorate('verifyApi', function(request: FastifyRequest, requiredScope: string): string {
    const clientIp = extractClientIp(request);
    try {
      return verifyApiClient(
        request.headers.authorization,
        requiredScope,
        options.apiClients,
        rateLimiter,
        clientIp,
        options.rateLimits.apiAuthPerMinute,
        options.rateLimits.apiPerMinute,
      );
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        throw { statusCode: 429, message: 'rate limit exceeded', retryAfterMs: error.retryAfterMs };
      }
      if (error instanceof AuthenticationError) {
        throw { statusCode: 401, message: error.message };
      }
      if (error instanceof AuthorizationError) {
        throw { statusCode: 403, message: error.message };
      }
      throw error;
    }
  });

  /**
   * Verify device HMAC authentication.
   */
  app.decorate('verifyDevice', function(request: FastifyRequest, body: Buffer): { deviceId: string; secret: Buffer } {
    const clientIp = extractClientIp(request);
    try {
      const headers = parseDeviceAuthHeaders(request.headers as Record<string, string>);
      const secret = verifyDeviceRequest(
        headers,
        body,
        Date.now(),
        options.deviceSecrets,
        deviceRepo,
        rateLimiter,
        clientIp,
        options.rateLimits.ingestPerMinute,
        options.rateLimits.devicePerMinute,
      );
      return { deviceId: headers.deviceId, secret };
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        throw { statusCode: 429, message: 'rate limit exceeded', retryAfterMs: error.retryAfterMs };
      }
      if (error instanceof AuthenticationError) {
        throw { statusCode: 401, message: error.message };
      }
      throw error;
    }
  });

  // Add error handler for auth errors
  app.setErrorHandler((error: any, _request, reply) => {
    if (error.statusCode) {
      const headers: Record<string, string> = {};
      if (error.retryAfterMs) {
        headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
      }
      return reply.status(error.statusCode).headers(headers).send({ error: error.message });
    }
    // Default error handling
    app.log.error(error);
    return reply.status(500).send({ error: 'internal server error' });
  });
});

/**
 * Extract client IP from request, respecting trust proxy.
 */
function extractClientIp(request: FastifyRequest): string {
  return request.ip;
}
