import { readFileSync } from 'node:fs';
import { loadApiClients, type ApiClient } from '../auth/api-client-auth.js';
import { base64Decode } from '../crypto/encoding.js';
import {
  DEFAULT_API_AUTH_REQUESTS_PER_MINUTE,
  DEFAULT_API_REQUESTS_PER_MINUTE,
  DEFAULT_DEVICE_REQUESTS_PER_MINUTE,
  DEFAULT_INGEST_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_OTP_MAX_AGE_SECONDS,
  DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE,
  DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE,
  DEFAULT_RETENTION_DAYS,
} from './constants.js';

export interface ServerSettings {
  retentionDays: number;
  otpMaxAgeSeconds: number;
  ingestRequestsPerMinute: number;
  deviceRequestsPerMinute: number;
  apiAuthRequestsPerMinute: number;
  apiRequestsPerMinute: number;
  pairingCreateRequestsPerMinute: number;
  pairingClaimRequestsPerMinute: number;
  pairingPublicEndpoint: string;
  pairingCertificatePinSha256Base64: string | null;
  maxConcurrentRequests: number;
  trustProxyHeaders: boolean;
}

export interface RuntimeConfig {
  apiClients: Map<string, ApiClient>;
  configuredDevices: Map<string, Buffer>;
  server: ServerSettings;
  notifications: {
    channels: NotificationChannelConfig[];
    feishu: FeishuConfig | null;
  };
}

export type NotificationChannelConfig =
  | FeishuChannelConfig
  | GenericWebhookChannelConfig
  | BarkChannelConfig;

interface BaseNotificationChannelConfig {
  id: string;
  name: string;
  type: 'FEISHU' | 'WEBHOOK' | 'BARK';
}

export interface FeishuChannelConfig extends BaseNotificationChannelConfig {
  type: 'FEISHU';
  webhookUrl: string;
  signingSecret: string | null;
}

export interface FeishuConfig {
  webhookUrl: string;
  signingSecret: string | null;
}

export interface GenericWebhookChannelConfig extends BaseNotificationChannelConfig {
  type: 'WEBHOOK';
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  query: Record<string, string>;
  contentType: string;
  bodyTemplate: string;
  timeoutMs: number;
}

export interface BarkChannelConfig extends BaseNotificationChannelConfig {
  type: 'BARK';
  server: string;
  deviceKey: string;
  group: string;
  sound: string | null;
  level: 'active' | 'timeSensitive' | 'passive' | 'critical';
  call: boolean;
}

const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  otpMaxAgeSeconds: DEFAULT_OTP_MAX_AGE_SECONDS,
  ingestRequestsPerMinute: DEFAULT_INGEST_REQUESTS_PER_MINUTE,
  deviceRequestsPerMinute: DEFAULT_DEVICE_REQUESTS_PER_MINUTE,
  apiAuthRequestsPerMinute: DEFAULT_API_AUTH_REQUESTS_PER_MINUTE,
  apiRequestsPerMinute: DEFAULT_API_REQUESTS_PER_MINUTE,
  pairingCreateRequestsPerMinute: DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE,
  pairingClaimRequestsPerMinute: DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE,
  pairingPublicEndpoint: '',
  pairingCertificatePinSha256Base64: null,
  maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
  trustProxyHeaders: false,
};

export function emptyRuntimeConfig(): RuntimeConfig {
  return {
    apiClients: new Map(),
    configuredDevices: new Map(),
    server: { ...DEFAULT_SERVER_SETTINGS },
    notifications: { channels: [], feishu: null },
  };
}

export function loadRuntimeConfig(path: string): RuntimeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`failed to load gateway config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRuntimeConfig(parsed);
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const root = requireRecord(value, 'gateway config');
  if (root.api_clients !== undefined && !isRecord(root.api_clients)) {
    throw new Error('api_clients must be an object');
  }
  if (root.devices !== undefined && !isRecord(root.devices)) {
    throw new Error('devices must be an object');
  }
  if (root.server !== undefined && !isRecord(root.server)) {
    throw new Error('server must be an object');
  }
  if (root.notifications !== undefined && !isRecord(root.notifications)) {
    throw new Error('notifications must be an object');
  }

  return {
    apiClients: loadApiClients(root),
    configuredDevices: parseConfiguredDevices(root.devices ?? {}),
    server: parseServerSettings(root.server ?? {}),
    notifications: parseNotificationSettings(root.notifications ?? {}),
  };
}

function parseNotificationSettings(value: unknown): RuntimeConfig['notifications'] {
  const settings = requireRecord(value, 'notifications');
  const channels = settings.channels === undefined
    ? []
    : parseNotificationChannels(settings.channels);
  if (settings.feishu === undefined) return { channels, feishu: null };
  const feishu = requireRecord(settings.feishu, 'notifications.feishu');
  const webhookUrl = optionalString(feishu, 'webhook_url', '').trim();
  if (!webhookUrl) {
    throw new Error('notifications.feishu.webhook_url is required');
  }
  validateFeishuWebhookUrl(webhookUrl);
  const signingSecret = optionalString(feishu, 'signing_secret', '').trim();
  if (signingSecret.length > 256) {
    throw new Error('notifications.feishu.signing_secret is too long');
  }
  const legacyChannel = {
    id: 'feishu',
    name: 'Feishu',
    type: 'FEISHU' as const,
    webhookUrl,
    signingSecret: signingSecret || null,
  };
  if (channels.some(channel => channel.id === legacyChannel.id)) {
    throw new Error('notification channel IDs must be unique');
  }
  return {
    channels: [legacyChannel, ...channels],
    feishu: {
      webhookUrl,
      signingSecret: signingSecret || null,
    },
  };
}

function parseNotificationChannels(value: unknown): NotificationChannelConfig[] {
  if (!Array.isArray(value)) throw new Error('notifications.channels must be an array');
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const channel = requireRecord(raw, `notifications.channels[${index}]`);
    const id = optionalString(channel, 'id', '').trim();
    const name = optionalString(channel, 'name', '').trim();
    const type = optionalString(channel, 'type', '').trim().toUpperCase();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new Error(`notifications.channels[${index}].id is invalid`);
    }
    if (seen.has(id)) throw new Error('notification channel IDs must be unique');
    seen.add(id);
    if (!name || name.length > 128) {
      throw new Error(`notifications.channels[${index}].name is invalid`);
    }
    if (type === 'FEISHU') {
      const webhookUrl = optionalString(channel, 'webhook_url', '').trim();
      validateFeishuWebhookUrl(webhookUrl);
      const signingSecret = optionalString(channel, 'signing_secret', '').trim();
      if (signingSecret.length > 256) throw new Error('notification signing secret is too long');
      return { id, name, type, webhookUrl, signingSecret: signingSecret || null };
    }
    if (type === 'WEBHOOK') {
      const url = validateHttpEndpoint(
        optionalString(channel, 'url', '').trim(),
        `notifications.channels[${index}].url`,
      );
      const method = optionalString(channel, 'method', 'POST').trim().toUpperCase();
      if (!['POST', 'PUT', 'PATCH'].includes(method)) {
        throw new Error(`notifications.channels[${index}].method is invalid`);
      }
      const headers = stringRecord(channel.headers ?? {}, `notifications.channels[${index}].headers`);
      const query = stringRecord(channel.query ?? {}, `notifications.channels[${index}].query`);
      const contentType = optionalString(channel, 'content_type', 'application/json').trim();
      const bodyTemplate = optionalString(channel, 'body_template', '').trim();
      if (!bodyTemplate || bodyTemplate.length > 64_000) {
        throw new Error(`notifications.channels[${index}].body_template is invalid`);
      }
      return {
        id,
        name,
        type,
        url,
        method: method as 'POST' | 'PUT' | 'PATCH',
        headers,
        query,
        contentType,
        bodyTemplate,
        timeoutMs: integerSetting(channel, 'timeout_ms', 10_000, 1_000, 30_000),
      };
    }
    if (type === 'BARK') {
      const server = validateHttpEndpoint(
        optionalString(channel, 'server', 'https://api.day.app').trim().replace(/\/+$/, ''),
        `notifications.channels[${index}].server`,
      ).replace(/\/+$/, '');
      const deviceKey = optionalString(channel, 'device_key', '').trim();
      if (!deviceKey || deviceKey.length > 512) {
        throw new Error(`notifications.channels[${index}].device_key is invalid`);
      }
      const level = optionalString(channel, 'level', 'active').trim();
      if (!['active', 'timeSensitive', 'passive', 'critical'].includes(level)) {
        throw new Error(`notifications.channels[${index}].level is invalid`);
      }
      const call = channel.call ?? false;
      if (typeof call !== 'boolean') {
        throw new Error(`notifications.channels[${index}].call must be a boolean`);
      }
      return {
        id,
        name,
        type,
        server,
        deviceKey,
        group: optionalString(channel, 'group', 'CA Connection').trim().slice(0, 128),
        sound: optionalString(channel, 'sound', '').trim() || null,
        level: level as BarkChannelConfig['level'],
        call,
      };
    }
    throw new Error(`notifications.channels[${index}].type is invalid`);
  });
}

function validateHttpEndpoint(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`${name} is invalid`);
  }
  return url.toString();
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = requireRecord(value, name);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!key.trim() || typeof item !== 'string') throw new Error(`${name} must contain strings`);
    result[key] = item;
  }
  return result;
}

export function validateFeishuWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('notifications.feishu.webhook_url is invalid');
  }
  if (
    url.protocol !== 'https:'
    || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)
    || (url.port !== '' && url.port !== '443')
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname)
  ) {
    throw new Error('notifications.feishu.webhook_url is invalid');
  }
}

function parseConfiguredDevices(value: unknown): Map<string, Buffer> {
  const devices = requireRecord(value, 'devices');
  const result = new Map<string, Buffer>();
  for (const [deviceId, rawDevice] of Object.entries(devices)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
      throw new Error(`invalid device ID: ${deviceId}`);
    }
    const device = requireRecord(rawDevice, `device ${deviceId}`);
    if (typeof device.secret_base64 !== 'string') {
      throw new Error(`invalid device secret for ${deviceId}`);
    }
    let secret: Buffer;
    try {
      secret = base64Decode(device.secret_base64);
    } catch {
      throw new Error(`invalid device secret for ${deviceId}`);
    }
    if (secret.length < 32) {
      throw new Error(`secret for ${deviceId} is shorter than 32 bytes`);
    }
    result.set(deviceId, secret);
  }
  return result;
}

function parseServerSettings(value: unknown): ServerSettings {
  const settings = requireRecord(value, 'server');
  const pairingPublicEndpoint = optionalString(settings, 'pairing_public_endpoint', '').trim().replace(/\/$/, '');
  if (pairingPublicEndpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(pairingPublicEndpoint);
    } catch {
      throw new Error('pairing_public_endpoint must be an HTTPS origin');
    }
    if (
      endpoint.protocol !== 'https:'
      || !endpoint.hostname
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    ) {
      throw new Error('pairing_public_endpoint must be an HTTPS origin');
    }
  }

  const rawPin = optionalString(settings, 'pairing_certificate_pin_sha256_base64', '').trim();
  if (rawPin) {
    let pin: Buffer;
    try {
      pin = base64Decode(rawPin);
    } catch {
      throw new Error('pairing_certificate_pin_sha256_base64 is invalid');
    }
    if (pin.length !== 32) {
      throw new Error('pairing_certificate_pin_sha256_base64 is invalid');
    }
  }

  const trustProxyHeaders = settings.trust_proxy_headers ?? false;
  if (typeof trustProxyHeaders !== 'boolean') {
    throw new Error('trust_proxy_headers must be a boolean');
  }

  return {
    retentionDays: integerSetting(settings, 'retention_days', DEFAULT_RETENTION_DAYS, 1, 3650),
    otpMaxAgeSeconds: integerSetting(settings, 'otp_max_age_seconds', DEFAULT_OTP_MAX_AGE_SECONDS, 30, 3600),
    ingestRequestsPerMinute: integerSetting(settings, 'ingest_requests_per_minute', DEFAULT_INGEST_REQUESTS_PER_MINUTE, 1, 100_000),
    deviceRequestsPerMinute: integerSetting(settings, 'device_requests_per_minute', DEFAULT_DEVICE_REQUESTS_PER_MINUTE, 1, 100_000),
    apiAuthRequestsPerMinute: integerSetting(settings, 'api_auth_requests_per_minute', DEFAULT_API_AUTH_REQUESTS_PER_MINUTE, 1, 100_000),
    apiRequestsPerMinute: integerSetting(settings, 'api_requests_per_minute', DEFAULT_API_REQUESTS_PER_MINUTE, 1, 100_000),
    pairingCreateRequestsPerMinute: integerSetting(settings, 'pairing_create_requests_per_minute', DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE, 1, 10_000),
    pairingClaimRequestsPerMinute: integerSetting(settings, 'pairing_claim_requests_per_minute', DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE, 1, 10_000),
    pairingPublicEndpoint,
    pairingCertificatePinSha256Base64: rawPin || null,
    maxConcurrentRequests: integerSetting(settings, 'max_concurrent_requests', DEFAULT_MAX_CONCURRENT_REQUESTS, 1, 1024),
    trustProxyHeaders,
  };
}

function integerSetting(
  settings: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = settings[key] ?? fallback;
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalString(settings: Record<string, unknown>, key: string, fallback: string): string {
  const value = settings[key] ?? fallback;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
