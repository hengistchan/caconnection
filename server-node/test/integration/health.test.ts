/**
 * Integration tests for health, version, and readiness endpoints.
 *
 * These endpoints must return identical responses to the Python gateway.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseRuntimeConfig } from '../../src/config/runtime-config.js';

describe('Health Endpoints', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'gateway-test-'));
    app = await buildApp({
      database: { path: join(tempDir, 'test.db') },
      runtimeConfig: parseRuntimeConfig({
        devices: {
          'test-device': {
            secret_base64: Buffer.alloc(32, 7).toString('base64'),
          },
        },
        api_clients: {
          'test-client': {
            token_sha256: createHash('sha256').update('test-token').digest('hex'),
            scopes: ['*'],
          },
        },
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /version', () => {
    it('should return version information matching Python format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/version',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // These fields must match the Python gateway exactly
      expect(body).toHaveProperty('service', 'caconnection-gateway');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('apiVersion', 1);
      expect(body).toHaveProperty('protocolSchemaVersion', 2);
    });
  });

  describe('GET /ready', () => {
    it('should return 200 when database, devices and API clients are ready', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready' });
    });
  });
});
