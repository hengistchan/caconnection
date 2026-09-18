import { request } from 'node:https';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { encryptPayload, type Envelope } from '../crypto/payload-crypto.js';
import { expectedSignature } from '../crypto/request-signature.js';

export async function runProtocolSmoke(options: {
  url: string;
  configPath: string;
  deviceId?: string;
  connectHost?: string;
  caFile?: string;
}): Promise<number> {
  const endpoint = new URL(options.url);
  if (
    endpoint.protocol !== 'https:'
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')
  ) {
    throw new Error('endpoint must be an HTTPS origin URL');
  }

  const config = loadRuntimeConfig(options.configPath);
  const deviceId = options.deviceId ?? config.configuredDevices.keys().next().value;
  const secret = deviceId ? config.configuredDevices.get(deviceId) : undefined;
  if (!deviceId || !secret) throw new Error('selected device is not configured');

  const timestamp = Date.now();
  const unique = randomUUID().replaceAll('-', '');
  const envelope: Envelope = {
    schemaVersion: 1,
    deliveryId: `production-smoke-${unique}`,
    sourceEventId: `production-smoke-${unique}`,
    eventType: 'LOCAL_SELF_TEST',
    createdAt: timestamp,
    subscriptionId: null,
    slotIndex: null,
    payload: { type: 'LOCAL_SELF_TEST', source: 'production-deployment-check' },
  };
  const body = Buffer.from(JSON.stringify(encryptPayload(envelope, deviceId, secret)));
  const nonce = randomUUID();
  const idempotencyKey = `production-smoke-${unique}`;
  const signature = expectedSignature(secret, timestamp, nonce, deviceId, idempotencyKey, body);

  const response = await sendRequest(endpoint, body, {
    deviceId,
    timestamp,
    nonce,
    idempotencyKey,
    signature,
    connectHost: options.connectHost,
    caFile: options.caFile,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`protocol smoke failed with HTTP ${response.status}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new Error('protocol smoke returned invalid JSON');
  }
  if (typeof value !== 'object' || value === null || (value as Record<string, unknown>).accepted !== true) {
    throw new Error('protocol smoke was not accepted');
  }
  return response.status;
}

function sendRequest(
  endpoint: URL,
  body: Buffer,
  options: {
    deviceId: string;
    timestamp: number;
    nonce: string;
    idempotencyKey: string;
    signature: string;
    connectHost?: string;
    caFile?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: 'https:',
      hostname: options.connectHost ?? endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : 443,
      path: '/v1/events',
      method: 'POST',
      servername: endpoint.hostname,
      ca: options.caFile ? readFileSync(options.caFile) : undefined,
      headers: {
        Host: endpoint.host,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
        'X-Gateway-Device': options.deviceId,
        'X-Gateway-Timestamp': String(options.timestamp),
        'X-Gateway-Nonce': options.nonce,
        'X-Gateway-Signature': options.signature,
        'Idempotency-Key': options.idempotencyKey,
      },
      timeout: 10_000,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => {
        if (chunks.reduce((total, value) => total + value.length, 0) < 16_384) {
          chunks.push(Buffer.from(chunk));
        }
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('protocol smoke timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const status = await runProtocolSmoke(args);
  console.log(`Signed encrypted protocol smoke test: PASS (HTTP ${status})`);
}

function parseArguments(argv: string[]): {
  url: string;
  configPath: string;
  deviceId?: string;
  connectHost?: string;
  caFile?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    values.set(key, value);
  }
  const url = values.get('--url');
  const configPath = values.get('--config');
  if (!url || !configPath) throw new Error('--url and --config are required');
  return {
    url,
    configPath,
    deviceId: values.get('--device-id'),
    connectHost: values.get('--connect-host'),
    caFile: values.get('--ca-file'),
  };
}

if (basename(process.argv[1] ?? '') === 'protocol-smoke.js') {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
