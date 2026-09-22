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

  it('validates Feishu custom-bot configuration', () => {
    const parsed = parseRuntimeConfig({
      ...validConfig(),
      notifications: {
        feishu: {
          webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop',
          signing_secret: 'signing-secret',
        },
      },
    });
    expect(parsed.notifications.feishu).toEqual({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop',
      signingSecret: 'signing-secret',
    });
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      notifications: {
        feishu: {
          webhook_url: 'https://example.com/open-apis/bot/v2/hook/abcdefghijklmnop',
        },
      },
    })).toThrow('webhook_url is invalid');
    expect(() => parseRuntimeConfig({
      ...validConfig(),
      notifications: {
        feishu: {
          webhook_url: 'http://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop',
        },
      },
    })).toThrow('webhook_url is invalid');
  });

  it('parses generic Webhook and Bark notification channels', () => {
    const parsed = parseRuntimeConfig({
      ...validConfig(),
      notifications: {
        channels: [
          {
            id: 'home',
            name: 'Home Webhook',
            type: 'webhook',
            url: 'https://example.test/hooks',
            headers: { Authorization: 'Bearer token' },
            query: { source: '{{event.type}}' },
            content_type: 'application/json',
            body_template: '{"event":"{{event.type}}"}',
          },
          {
            id: 'iphone',
            name: 'Bark',
            type: 'bark',
            server: 'https://api.day.app',
            device_key: 'device-key',
            group: 'CA Connection',
            level: 'active',
            call: true,
          },
        ],
      },
    });

    expect(parsed.notifications.channels).toMatchObject([
      {
        id: 'home',
        type: 'WEBHOOK',
        method: 'POST',
        timeoutMs: 10_000,
      },
      {
        id: 'iphone',
        type: 'BARK',
        server: 'https://api.day.app',
        call: true,
      },
    ]);
  });
});
