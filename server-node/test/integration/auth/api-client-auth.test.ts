/**
 * Integration tests for API client bearer authentication.
 *
 * Tests token verification, scope checking, device access control, and rate limiting.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SlidingWindowRateLimiter } from '../../../src/auth/rate-limiter.js';
import {
  verifyApiClient,
  getClientAllowedDeviceIds,
  canAccessDevice,
  getClientDeviceSecrets,
  type ApiClient,
} from '../../../src/auth/api-client-auth.js';
import { createHash, randomBytes } from 'node:crypto';

function createTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

function createClients(configs: Array<{ id: string; scopes: string[]; allowedDeviceIds?: string[] | null }>): Map<string, ApiClient> {
  const clients = new Map<string, ApiClient>();
  for (const config of configs) {
    clients.set(config.id, {
      clientId: config.id,
      tokenSha256: createTokenHash(`token-${config.id}`),
      scopes: new Set(config.scopes),
      allowedDeviceIds: config.allowedDeviceIds ? new Set(config.allowedDeviceIds) : null,
    });
  }
  return clients;
}

describe('API Client Authentication', () => {
  let rateLimiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    rateLimiter = new SlidingWindowRateLimiter();
  });

  describe('verifyApiClient', () => {
    it('should verify a valid token', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);
      const token = 'token-admin';

      const clientId = verifyApiClient(
        `Bearer ${token}`,
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      );

      expect(clientId).toBe('admin');
    });

    it('should throw on missing Authorization header', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(() => verifyApiClient(
        undefined,
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('authentication required');
    });

    it('should throw on non-Bearer token', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(() => verifyApiClient(
        'Basic token-admin',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('authentication required');
    });

    it('should throw on empty token', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(() => verifyApiClient(
        'Bearer ',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('authentication failed');
    });

    it('should throw on token longer than 512 characters', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(() => verifyApiClient(
        `Bearer ${'x'.repeat(513)}`,
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('authentication failed');
    });

    it('should throw on unknown token', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(() => verifyApiClient(
        'Bearer unknown-token',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('authentication failed');
    });

    it('should throw on insufficient scope', () => {
      const clients = createClients([{ id: 'reader', scopes: ['messages:read'] }]);

      expect(() => verifyApiClient(
        'Bearer token-reader',
        'messages:send',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      )).toThrow('insufficient scope');
    });

    it('should allow wildcard scope', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      const clientId = verifyApiClient(
        'Bearer token-admin',
        'messages:send',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      );

      expect(clientId).toBe('admin');
    });

    it('should allow specific scope', () => {
      const clients = createClients([{ id: 'reader', scopes: ['messages:read'] }]);

      const clientId = verifyApiClient(
        'Bearer token-reader',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        60,
      );

      expect(clientId).toBe('reader');
    });

    it('should enforce auth rate limit', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      // Exhaust auth rate limit
      for (let i = 0; i < 5; i++) {
        try {
          verifyApiClient('Bearer unknown', 'messages:read', clients, rateLimiter, '127.0.0.1', 5, 60);
        } catch {
          // Ignore
        }
      }

      // Next request should be rate limited
      expect(() => verifyApiClient(
        'token-admin',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        5,
        60,
      )).toThrow('rate limit exceeded');
    });

    it('should enforce API rate limit per client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      // Exhaust API rate limit
      for (let i = 0; i < 3; i++) {
        verifyApiClient('Bearer token-admin', 'messages:read', clients, rateLimiter, '127.0.0.1', 120, 3);
      }

      // Next request should be rate limited
      expect(() => verifyApiClient(
        'Bearer token-admin',
        'messages:read',
        clients,
        rateLimiter,
        '127.0.0.1',
        120,
        3,
      )).toThrow('rate limit exceeded');
    });

    it('should track different clients independently', () => {
      const clients = createClients([
        { id: 'admin', scopes: ['*'] },
        { id: 'reader', scopes: ['messages:read'] },
      ]);

      // Exhaust rate limit for admin
      for (let i = 0; i < 3; i++) {
        verifyApiClient('Bearer token-admin', 'messages:read', clients, rateLimiter, '127.0.0.1', 120, 3);
      }

      // Reader should still work
      const clientId = verifyApiClient('Bearer token-reader', 'messages:read', clients, rateLimiter, '127.0.0.1', 120, 3);
      expect(clientId).toBe('reader');
    });
  });

  describe('getClientAllowedDeviceIds', () => {
    it('should return null for unrestricted client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      const allowed = getClientAllowedDeviceIds('admin', clients);

      expect(allowed).toBeNull();
    });

    it('should return device IDs for restricted client', () => {
      const clients = createClients([{ id: 'scoped', scopes: ['*'], allowedDeviceIds: ['device-1', 'device-2'] }]);

      const allowed = getClientAllowedDeviceIds('scoped', clients);

      expect(allowed).not.toBeNull();
      expect(allowed!.has('device-1')).toBe(true);
      expect(allowed!.has('device-2')).toBe(true);
      expect(allowed!.size).toBe(2);
    });

    it('should return null for unknown client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      const allowed = getClientAllowedDeviceIds('unknown', clients);

      expect(allowed).toBeNull();
    });
  });

  describe('canAccessDevice', () => {
    it('should return true for unrestricted client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(canAccessDevice('admin', 'any-device', clients)).toBe(true);
    });

    it('should return true for allowed device', () => {
      const clients = createClients([{ id: 'scoped', scopes: ['*'], allowedDeviceIds: ['device-1'] }]);

      expect(canAccessDevice('scoped', 'device-1', clients)).toBe(true);
    });

    it('should return false for disallowed device', () => {
      const clients = createClients([{ id: 'scoped', scopes: ['*'], allowedDeviceIds: ['device-1'] }]);

      expect(canAccessDevice('scoped', 'device-2', clients)).toBe(false);
    });

    it('should return true for unknown client (fail open)', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);

      expect(canAccessDevice('unknown', 'device-1', clients)).toBe(true);
    });
  });

  describe('getClientDeviceSecrets', () => {
    it('should return all secrets for unrestricted client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);
      const allSecrets = new Map([
        ['device-1', Buffer.from('secret1')],
        ['device-2', Buffer.from('secret2')],
      ]);

      const secrets = getClientDeviceSecrets('admin', clients, allSecrets);

      expect(secrets.size).toBe(2);
      expect(secrets.has('device-1')).toBe(true);
      expect(secrets.has('device-2')).toBe(true);
    });

    it('should return filtered secrets for restricted client', () => {
      const clients = createClients([{ id: 'scoped', scopes: ['*'], allowedDeviceIds: ['device-1'] }]);
      const allSecrets = new Map([
        ['device-1', Buffer.from('secret1')],
        ['device-2', Buffer.from('secret2')],
      ]);

      const secrets = getClientDeviceSecrets('scoped', clients, allSecrets);

      expect(secrets.size).toBe(1);
      expect(secrets.has('device-1')).toBe(true);
      expect(secrets.has('device-2')).toBe(false);
    });

    it('should return all secrets for unknown client', () => {
      const clients = createClients([{ id: 'admin', scopes: ['*'] }]);
      const allSecrets = new Map([
        ['device-1', Buffer.from('secret1')],
        ['device-2', Buffer.from('secret2')],
      ]);

      const secrets = getClientDeviceSecrets('unknown', clients, allSecrets);

      expect(secrets.size).toBe(2);
    });
  });
});