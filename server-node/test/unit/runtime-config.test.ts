import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../../src/config/runtime-config.js';

function validConfig() {
  return {
    devices: {
      gateway: { secret_base64: Buffer.alloc(32, 1).toString('base64') },
    },
    api_clients: {
      admin: {
        token_sha256: createHash('sha256').update('token').digest('hex'),
        scopes: ['*'],
      },
    },
    server: {},
  };
}

describe('runtime config', () => {
  it('rejects invalid config shapes instead of starting fail-open', () => {
    expect(() => parseRuntimeConfig([])).toThrow('gateway config must be an object');
    expect(() => parseRuntimeConfig({ ...validConfig(), api_clients: [] })).toThrow('api_clients must be an object');
    expect(() => parseRuntimeConfig({ ...validConfig(), server: { retention_days: 0 } })).toThrow('retention_days');
  });

  it('strictly validates Base64 device secrets and certificate pins', () => {
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      devices: { gateway: { secret_base64: `${Buffer.alloc(32, 1).toString('base64')}!` } },
    })).toThrow('invalid device secret');
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      server: { pairing_certificate_pin_sha256_base64: 'not-base64' },
    })).toThrow('pairing_certificate_pin_sha256_base64 is invalid');
  });

  it('rejects non-origin or insecure pairing endpoints', () => {
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      server: { pairing_public_endpoint: 'http://gateway.example.test' },
    })).toThrow('HTTPS origin');
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      server: { pairing_public_endpoint: 'https://gateway.example.test/path' },
    })).toThrow('HTTPS origin');
  });
});
