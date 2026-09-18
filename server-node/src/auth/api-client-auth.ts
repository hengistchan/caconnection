/**
 * API Client bearer token authentication.
 *
 * Verifies admin API requests using:
 *   - Authorization: Bearer <token> header
 *   - SHA-256 token hash comparison
 *   - Scope-based authorization
 *   - Per-client device access control
 *
 * Must match the Python gateway's authorize_api exactly.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthenticationError, AuthorizationError, RateLimitError } from './auth-errors.js';
import type { SlidingWindowRateLimiter } from './rate-limiter.js';
import { VALID_SCOPES } from '../config/constants.js';

export interface ApiClient {
  clientId: string;
  tokenSha256: string;
  scopes: Set<string>;
  allowedDeviceIds: Set<string> | null;
}

export interface ApiClientConfig {
  token_sha256: string;
  scopes: string[];
  allowedDeviceIds?: string[] | null;
}

/**
 * Parse API clients from configuration.
 */
export function loadApiClients(config: Record<string, unknown>): Map<string, ApiClient> {
  const clients = new Map<string, ApiClient>();
  const apiClients = config.api_clients as Record<string, ApiClientConfig> | undefined;

  if (!apiClients) return clients;

  for (const [clientId, value] of Object.entries(apiClients)) {
    // Validate client ID
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) {
      throw new Error(`Invalid API client ID: ${clientId}`);
    }

    // Validate token hash
    const tokenSha256 = (value.token_sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tokenSha256)) {
      throw new Error(`Invalid API token hash for ${clientId}`);
    }

    // Validate scopes
    const scopes = new Set(value.scopes || []);
    for (const scope of scopes) {
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(`Invalid API scopes for ${clientId}`);
      }
    }

    // Validate allowed device IDs
    let allowedDeviceIds: Set<string> | null = null;
    if (value.allowedDeviceIds !== undefined && value.allowedDeviceIds !== null) {
      if (!Array.isArray(value.allowedDeviceIds) || value.allowedDeviceIds.length === 0) {
        throw new Error(`Invalid allowedDeviceIds for ${clientId}`);
      }
      for (const deviceId of value.allowedDeviceIds) {
        if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
          throw new Error(`Invalid allowedDeviceIds for ${clientId}`);
        }
      }
      if (new Set(value.allowedDeviceIds).size !== value.allowedDeviceIds.length) {
        throw new Error(`Invalid allowedDeviceIds for ${clientId}`);
      }
      allowedDeviceIds = new Set(value.allowedDeviceIds);
    }

    clients.set(clientId, {
      clientId,
      tokenSha256,
      scopes,
      allowedDeviceIds,
    });
  }

  return clients;
}

/**
 * Verify an API client request.
 *
 * Returns the client ID if authentication succeeds.
 * Throws AuthenticationError, AuthorizationError, or RateLimitError on failure.
 */
export function verifyApiClient(
  authorizationHeader: string | undefined,
  requiredScope: string,
  clients: Map<string, ApiClient>,
  rateLimiter: SlidingWindowRateLimiter,
  clientIp: string,
  authRateLimit: number,
  apiRateLimit: number,
): string {
  // Check IP-based auth rate limit
  const authResult = rateLimiter.allow('api-auth', clientIp, authRateLimit, nowMs());
  if (!authResult.allowed) {
    throw new RateLimitError(authResult.retryAfterMs);
  }

  // Extract bearer token
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('authentication required');
  }

  const token = authorizationHeader.slice(7).trim();
  if (!token || token.length > 512) {
    throw new AuthenticationError('authentication failed');
  }

  // Hash token and compare
  const tokenHash = createHash('sha256').update(token, 'utf-8').digest('hex');

  let matchedClient: ApiClient | null = null;
  for (const client of clients.values()) {
    if (timingSafeEqual(Buffer.from(client.tokenSha256, 'utf-8'), Buffer.from(tokenHash, 'utf-8'))) {
      matchedClient = client;
      break;
    }
  }

  if (!matchedClient) {
    throw new AuthenticationError('authentication failed');
  }

  // Check scope
  if (!matchedClient.scopes.has(requiredScope) && !matchedClient.scopes.has('*')) {
    throw new AuthorizationError('insufficient scope');
  }

  // Check client rate limit
  const apiResult = rateLimiter.allow('api', matchedClient.clientId, apiRateLimit, nowMs());
  if (!apiResult.allowed) {
    throw new RateLimitError(apiResult.retryAfterMs);
  }

  return matchedClient.clientId;
}

/**
 * Get allowed device IDs for a client.
 * Returns null if the client has access to all devices.
 */
export function getClientAllowedDeviceIds(
  clientId: string,
  clients: Map<string, ApiClient>,
): Set<string> | null {
  const client = clients.get(clientId);
  return client?.allowedDeviceIds ?? null;
}

/**
 * Check if a client can access a specific device.
 */
export function canAccessDevice(
  clientId: string,
  deviceId: string,
  clients: Map<string, ApiClient>,
): boolean {
  const allowed = getClientAllowedDeviceIds(clientId, clients);
  return allowed === null || allowed.has(deviceId);
}

/**
 * Get device secrets accessible by a client.
 */
export function getClientDeviceSecrets(
  clientId: string,
  clients: Map<string, ApiClient>,
  allSecrets: Map<string, Buffer>,
): Map<string, Buffer> {
  const allowed = getClientAllowedDeviceIds(clientId, clients);
  if (allowed === null) return allSecrets;

  const result = new Map<string, Buffer>();
  for (const [deviceId, secret] of allSecrets) {
    if (allowed.has(deviceId)) {
      result.set(deviceId, secret);
    }
  }
  return result;
}

function nowMs(): number {
  return Date.now();
}
