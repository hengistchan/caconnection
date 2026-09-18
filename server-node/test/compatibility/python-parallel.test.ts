/**
 * P7: Parallel acceptance tests.
 *
 * These tests verify that the Node.js implementation produces identical
 * responses to the Python gateway when reading from the same database.
 *
 * The test flow:
 * 1. Start Python gateway with a test database
 * 2. Populate test data via Python API
 * 3. Start Node gateway with the same database
 * 4. Make identical requests to both
 * 5. Compare JSON responses
 *
 * Run with: npm run test:compat
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { encryptPayload, type Envelope } from '../../src/crypto/payload-crypto.js';
import { expectedSignature } from '../../src/crypto/request-signature.js';

const PYTHON_SERVER = join(__dirname, '..', '..', '..', 'server', 'gateway_server.py');
const NODE_SERVER = join(__dirname, '..', '..', 'src', 'main.ts');
const DEVICE_ID = 'test-device';
const API_TOKEN = 'test-api-token';
const DEVICE_SECRET = Buffer.from('test-secret-key-at-least-32-bytes-long!');

// Helper to make HTTP requests
async function fetch(url: string, options: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, options);
}

// Helper to wait for server to be ready
async function waitForServer(url: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await setTimeout(100);
  }
  return false;
}

describe('P7: Parallel Acceptance Tests', () => {
  let tempDir: string;
  let pythonPort: number;
  let nodePort: number;
  let pythonProcess: ReturnType<typeof spawn> | null = null;
  let nodeProcess: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'p7-parallel-'));
    pythonPort = 18787;
    nodePort = 18788;

    // Create test config
    const config = {
      devices: {
        'test-device': {
          secret_base64: DEVICE_SECRET.toString('base64'),
        },
      },
      api_clients: {
        'test-client': {
          token_sha256: createHash('sha256')
            .update(API_TOKEN)
            .digest('hex'),
          scopes: ['*'],
        },
      },
      server: {
        retention_days: 30,
        pairing_public_endpoint: 'https://gateway.example.test',
      },
    };

    writeFileSync(join(tempDir, 'config.json'), JSON.stringify(config, null, 2));

    // Start Python gateway
    pythonProcess = spawn('python3', [
      PYTHON_SERVER,
      '--host', '127.0.0.1',
      '--port', String(pythonPort),
      '--config', join(tempDir, 'config.json'),
      '--database', join(tempDir, 'gateway.db'),
      '--no-tls',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Wait for Python to start
    const pythonReady = await waitForServer(`http://127.0.0.1:${pythonPort}`);
    if (!pythonReady) {
      throw new Error('Python server failed to start');
    }

    // Start Node gateway (using tsx for direct TypeScript execution)
    nodeProcess = spawn('npx', ['tsx', NODE_SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(nodePort),
        HOST: '127.0.0.1',
        DATABASE_PATH: join(tempDir, 'gateway.db'),
        CONFIG_PATH: join(tempDir, 'config.json'),
      },
      cwd: join(__dirname, '..', '..'),
    });

    // Wait for Node to start
    const nodeReady = await waitForServer(`http://127.0.0.1:${nodePort}`);
    if (!nodeReady) {
      throw new Error('Node server failed to start');
    }

  }, 30_000);

  afterAll(() => {
    if (pythonProcess) {
      pythonProcess.kill();
    }
    if (nodeProcess) {
      nodeProcess.kill();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Health Endpoints', () => {
    it('should return identical health responses', async () => {
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/health`),
        fetch(`http://127.0.0.1:${nodePort}/health`),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });

    it('should return identical version responses', async () => {
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/version`),
        fetch(`http://127.0.0.1:${nodePort}/version`),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      // Version will differ, but apiVersion and protocolSchemaVersion must match
      expect(pyBody.apiVersion).toBe(nodeBody.apiVersion);
      expect(pyBody.protocolSchemaVersion).toBe(nodeBody.protocolSchemaVersion);
      expect(pyBody.service).toBe(nodeBody.service);
    });

    it('should return identical ready responses', async () => {
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/ready`),
        fetch(`http://127.0.0.1:${nodePort}/ready`),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });
  });

  describe('Device Endpoints', () => {
    it('should return identical device list', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/devices`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/devices`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });

    it('should return identical device detail', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/devices/detail`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/devices/detail`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      // Compare devices (ignoring timing-sensitive fields)
      expect(pyBody.devices.length).toBe(nodeBody.devices.length);
      for (let i = 0; i < pyBody.devices.length; i++) {
        expect(pyBody.devices[i].deviceId).toBe(nodeBody.devices[i].deviceId);
        expect(pyBody.devices[i].description).toBe(nodeBody.devices[i].description);
        expect(pyBody.devices[i].health).toBe(nodeBody.devices[i].health);
      }
    });
  });

  describe('Group Endpoints', () => {
    it('should return identical group list', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/device-groups`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/device-groups`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });
  });

  describe('Message Endpoints', () => {
    it('should return identical empty messages', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/messages`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/messages`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });

    it('should return identical empty notifications', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/notifications`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/notifications`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });

    it('should return identical empty outbound messages', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/outbound-messages`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/outbound-messages`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody).toEqual(nodeBody);
    });
  });

  describe('Signed ingestion and write workflows', () => {
    it('accepts a signed pretty-printed SMS event and matches Python reads', async () => {
      const response = await signedNodePost('/v1/events', encryptedEvent('INCOMING_SMS', {
        originatingAddress: '+10086',
        body: 'ordinary compatibility message',
        partCount: 1,
        action: 'SMS_RECEIVED',
      }), 'parallel-sms');
      expect(response.status).toBe(201);

      const headers = { Authorization: `Bearer ${API_TOKEN}` };
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/messages?deviceId=${DEVICE_ID}`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/messages?deviceId=${DEVICE_ID}`, { headers }),
      ]);
      expect(pyRes.status).toBe(nodeRes.status);
      expect(await pyRes.json()).toEqual(await nodeRes.json());
    });

    it('queues, claims and completes an outbound command through real routes', async () => {
      const createRes = await fetch(`http://127.0.0.1:${nodePort}/v1/outbound-messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          slotIndex: 0,
          recipient: '+15551234567',
          body: 'compatibility outbound message',
          idempotencyKey: `parallel-outbound-${Date.now()}`,
        }),
      });
      expect(createRes.status).toBe(201);
      const commandId = (await createRes.json()).outboundMessage.commandId as string;

      const claimRes = await signedNodePost('/v1/device-commands/claim', { limit: 5 }, 'parallel-claim');
      expect(claimRes.status).toBe(200);
      const claimBody = await claimRes.json();
      expect(claimBody.commands.some((command: { commandId: string }) => command.commandId === commandId)).toBe(true);

      const statusRes = await signedNodePost('/v1/events', encryptedEvent('OUTBOUND_SMS_STATUS', {
        commandId,
        status: 'DELIVERED',
        resultCode: 0,
        errorDetail: null,
      }), 'parallel-status');
      expect(statusRes.status).toBe(201);

      const headers = { Authorization: `Bearer ${API_TOKEN}` };
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/outbound-messages?deviceId=${DEVICE_ID}`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/outbound-messages?deviceId=${DEVICE_ID}`, { headers }),
      ]);
      expect(pyRes.status).toBe(nodeRes.status);
      expect(await pyRes.json()).toEqual(await nodeRes.json());
    });

    it('creates and claims a pairing document using config.json settings', async () => {
      const createRes = await fetch(`http://127.0.0.1:${nodePort}/v1/pairings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(createRes.status).toBe(201);
      const pairing = (await createRes.json()).pairing;
      const document = JSON.parse(pairing.payload);
      expect(document.endpoint).toBe('https://gateway.example.test');

      const claimRes = await fetch(`http://127.0.0.1:${nodePort}/v1/pairings/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingToken: document.pairingToken }),
      });
      expect(claimRes.status).toBe(200);
      expect((await claimRes.json()).provisioning.deviceId).toBe(DEVICE_ID);
    });
  });

  describe('Audit Endpoints', () => {
    it('should return identical audit log structure', async () => {
      const headers = { 'Authorization': 'Bearer test-api-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/audit-log`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/audit-log`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      // Both should return valid responses
      expect(pyBody).toHaveProperty('entries');
      expect(nodeBody).toHaveProperty('entries');
      expect(Array.isArray(pyBody.entries)).toBe(true);
      expect(Array.isArray(nodeBody.entries)).toBe(true);
    });
  });

  describe('Authentication', () => {
    it('should reject unauthenticated requests identically', async () => {
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/messages`),
        fetch(`http://127.0.0.1:${nodePort}/v1/messages`),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody.error).toBe(nodeBody.error);
    });

    it('should reject invalid tokens identically', async () => {
      const headers = { 'Authorization': 'Bearer invalid-token' };

      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/messages`, { headers }),
        fetch(`http://127.0.0.1:${nodePort}/v1/messages`, { headers }),
      ]);

      const pyBody = await pyRes.json();
      const nodeBody = await nodeRes.json();

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyBody.error).toBe(nodeBody.error);
    });
  });

  describe('Error Responses', () => {
    it('should return identical 404 for unknown routes', async () => {
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pythonPort}/v1/nonexistent`),
        fetch(`http://127.0.0.1:${nodePort}/v1/nonexistent`),
      ]);

      expect(pyRes.status).toBe(nodeRes.status);
      expect(pyRes.status).toBe(404);
    });
  });
});

function encryptedEvent(eventType: string, payload: Record<string, unknown>) {
  const unique = `${eventType.toLowerCase()}-${Date.now()}-${Math.random()}`;
  const envelope: Envelope = {
    schemaVersion: 1,
    deliveryId: `delivery-${unique}`,
    sourceEventId: `source-${unique}`,
    eventType,
    createdAt: Date.now(),
    subscriptionId: 1,
    slotIndex: 0,
    payload,
  };
  return encryptPayload(envelope, DEVICE_ID, DEVICE_SECRET);
}

async function signedNodePost(
  path: string,
  value: Record<string, unknown>,
  noncePrefix: string,
): Promise<Response> {
  const rawBody = JSON.stringify(value, null, 2);
  const timestamp = Date.now();
  const nonce = `${noncePrefix}-${timestamp}-${Math.random()}`;
  const idempotencyKey = `idem-${nonce}`;
  const signature = expectedSignature(
    DEVICE_SECRET,
    timestamp,
    nonce,
    DEVICE_ID,
    idempotencyKey,
    Buffer.from(rawBody),
  );
  return fetch(`http://127.0.0.1:${18788}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Device': DEVICE_ID,
      'X-Gateway-Timestamp': String(timestamp),
      'X-Gateway-Nonce': nonce,
      'X-Gateway-Signature': signature,
      'Idempotency-Key': idempotencyKey,
    },
    body: rawBody,
  });
}
