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

  return {
    apiClients: loadApiClients(root),
    configuredDevices: parseConfiguredDevices(root.devices ?? {}),
    server: parseServerSettings(root.server ?? {}),
  };
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
