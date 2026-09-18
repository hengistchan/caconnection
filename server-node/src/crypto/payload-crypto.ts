/**
 * AES-256-GCM payload encryption/decryption.
 *
 * MUST produce byte-identical results to the Python gateway:
 *   - HKDF-SHA256 with device_id as salt, "caconnection/payload-encryption/v1" as info
 *   - 32-byte derived key
 *   - 12-byte random nonce
 *   - AAD: newline-joined fields in exact order
 *   - AES-256-GCM with ciphertext || authTag concatenation
 *   - Standard Base64 (not Base64URL)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { base64Decode, base64Encode } from './encoding.js';

const HKDF_INFO = Buffer.from('caconnection/payload-encryption/v1', 'utf-8');
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  algorithm: 'AES-256-GCM';
  nonceBase64: string;
  ciphertextBase64: string;
}

export interface Envelope {
  schemaVersion: number;
  deliveryId: string;
  sourceEventId: string;
  eventType: string;
  createdAt: number;
  subscriptionId?: number | null;
  slotIndex?: number | null;
  payload: Record<string, unknown> | EncryptedPayload;
  [key: string]: unknown;
}

/**
 * Derive the per-device payload encryption key using HKDF-SHA256.
 * salt = device_id (UTF-8 bytes), info = "caconnection/payload-encryption/v1"
 */
export function payloadKey(secret: Buffer, deviceId: string): Buffer {
  const salt = Buffer.from(deviceId, 'utf-8');
  // hkdfSync returns a Uint8Array
  const key = hkdfSync('sha256', secret, salt, HKDF_INFO, KEY_LENGTH);
  return Buffer.from(key);
}

/**
 * Build the AAD (Additional Authenticated Data) for AES-GCM.
 * Format: newline-joined fields in exact order matching Python.
 */
export function encryptionAad(envelope: Envelope, deviceId: string): Buffer {
  const parts = [
    '2',
    String(envelope.deliveryId),
    String(envelope.sourceEventId),
    String(envelope.eventType),
    String(envelope.createdAt),
    envelope.subscriptionId == null ? '' : String(envelope.subscriptionId),
    envelope.slotIndex == null ? '' : String(envelope.slotIndex),
    deviceId,
  ];
  return Buffer.from(parts.join('\n'), 'utf-8');
}

/**
 * Encrypt a plaintext payload. Returns a new envelope with schemaVersion=2
 * and an encrypted payload block.
 */
export function encryptPayload(
  envelope: Envelope,
  deviceId: string,
  secret: Buffer,
): Envelope {
  if (envelope.schemaVersion === 2) {
    return envelope;
  }

  const nonce = randomBytes(NONCE_LENGTH);
  const key = payloadKey(secret, deviceId);

  // Build outer envelope (everything except payload)
  const outer: Envelope = { ...envelope };
  delete (outer as Record<string, unknown>).payload;
  outer.schemaVersion = 2;

  // Encrypt the plaintext payload
  const plaintext = Buffer.from(
    JSON.stringify(envelope.payload, null, 0),
    'utf-8',
  );
  const aad = encryptionAad(outer, deviceId);

  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Concatenate ciphertext + authTag (matching Python AESGCM.encrypt behavior)
  const ciphertext = Buffer.concat([encrypted, authTag]);

  outer.payload = {
    algorithm: 'AES-256-GCM',
    nonceBase64: base64Encode(nonce),
    ciphertextBase64: base64Encode(ciphertext),
  };

  return outer;
}

/**
 * Decrypt an encrypted payload envelope. Returns the envelope with the
 * plaintext payload restored.
 */
export function decryptPayload(
  envelope: Envelope,
  deviceId: string,
  secret: Buffer,
): Envelope {
  if (envelope.schemaVersion === 1) {
    return envelope;
  }

  const encrypted = envelope.payload as EncryptedPayload;

  if (encrypted.algorithm !== 'AES-256-GCM') {
    throw new Error('unsupported payload encryption algorithm');
  }

  const nonce = base64Decode(encrypted.nonceBase64);
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error('invalid AES-GCM nonce length');
  }

  const ciphertextWithTag = base64Decode(encrypted.ciphertextBase64);
  const key = payloadKey(secret, deviceId);

  // Split ciphertext and auth tag (last 16 bytes)
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const aad = encryptionAad(envelope, deviceId);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf-8'));

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('decrypted payload must be a JSON object');
  }

  return {
    ...envelope,
    payload,
  };
}
