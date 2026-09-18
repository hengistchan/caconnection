import { ALLOWED_EVENT_TYPES } from '../config/constants.js';

export interface ValidatedEnvelope extends Record<string, unknown> {
  schemaVersion: 1 | 2;
  deliveryId: string;
  sourceEventId: string;
  eventType: string;
  createdAt: number;
  subscriptionId?: number | null;
  slotIndex?: number | null;
  payload: Record<string, unknown>;
}

export function validateEnvelope(value: unknown): ValidatedEnvelope {
  if (!isRecord(value)) {
    throw new Error('body must be a JSON object');
  }
  const required = ['schemaVersion', 'deliveryId', 'sourceEventId', 'eventType', 'createdAt', 'payload'];
  if (required.some(field => !(field in value))) {
    throw new Error('missing envelope fields');
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error('unsupported schemaVersion');
  }
  for (const field of ['deliveryId', 'sourceEventId']) {
    const fieldValue = value[field];
    if (typeof fieldValue !== 'string' || fieldValue.length < 1 || fieldValue.length > 128) {
      throw new Error(`invalid ${field}`);
    }
  }
  if (typeof value.eventType !== 'string' || !ALLOWED_EVENT_TYPES.has(value.eventType)) {
    throw new Error('unsupported eventType');
  }
  if (typeof value.createdAt !== 'number' || !Number.isInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error('invalid createdAt');
  }
  for (const field of ['subscriptionId', 'slotIndex']) {
    const fieldValue = value[field];
    if (fieldValue != null && (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue))) {
      throw new Error(`invalid ${field}`);
    }
  }
  const slotIndex = value.slotIndex;
  if (typeof slotIndex === 'number' && (slotIndex < 0 || slotIndex > 3)) {
    throw new Error('invalid slotIndex');
  }
  if (!isRecord(value.payload)) {
    throw new Error('payload must be a JSON object');
  }
  if (value.schemaVersion === 2) {
    if (value.payload.algorithm !== 'AES-256-GCM') {
      throw new Error('unsupported payload encryption');
    }
    if (!value.payload.nonceBase64 || !value.payload.ciphertextBase64) {
      throw new Error('missing encrypted payload fields');
    }
  }
  return value as ValidatedEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
