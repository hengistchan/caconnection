/**
 * Ingest routes - /v1/events, /v1/device-commands/claim
 *
 * Android device event ingestion and command claiming.
 * These are the highest-risk endpoints - they involve:
 *   - HMAC signature verification
 *   - AES-256-GCM decryption
 *   - Nonce replay protection
 *   - Multiple side effects per request
 */

import type { FastifyInstance } from 'fastify';
import { verifySignature } from '../crypto/request-signature.js';
import { decryptPayload } from '../crypto/payload-crypto.js';
import { MAX_CLOCK_SKEW_MS, MAX_BODY_BYTES } from '../config/constants.js';
import { extractOtpCandidates } from '../crypto/otp-extraction.js';

export async function ingestRoutes(app: FastifyInstance) {
  /**
   * POST /v1/events
   *
   * Upload one encrypted Android Outbox event.
   *
   * Headers:
   *   X-Gateway-Device: device_id
   *   X-Gateway-Timestamp: millisecond timestamp
   *   X-Gateway-Nonce: unique nonce (1-128 chars)
   *   X-Gateway-Signature: HMAC-SHA256 Base64
   *   Idempotency-Key: idempotency key (1-128 chars)
   *
   * Body: Encrypted envelope with schemaVersion 2
   */
  app.post('/v1/events', async (request, reply) => {
    // Rate limit by IP
    const clientIp = request.ip;
    const ipResult = app.rateLimiter.allow('ingest-ip', clientIp, 120, Date.now());
    if (!ipResult.allowed) {
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }

    // Read body as buffer for signature verification
    // Fastify parses the body, but we need the raw bytes for signature verification
    const bodyStr = JSON.stringify(request.body);
    const body = Buffer.from(bodyStr, 'utf-8');
    if (!body || body.length === 0 || body.length > MAX_BODY_BYTES) {
      return reply.status(body && body.length > MAX_BODY_BYTES ? 413 : 400).send({ error: 'invalid body size' });
    }

    // Extract headers
    const deviceId = request.headers['x-gateway-device'] as string;
    const nonce = request.headers['x-gateway-nonce'] as string;
    const idempotencyKey = request.headers['idempotency-key'] as string;
    const signature = request.headers['x-gateway-signature'] as string;
    const timestampStr = request.headers['x-gateway-timestamp'] as string;

    // Validate headers exist
    if (!deviceId || !nonce || !idempotencyKey || !signature || !timestampStr) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    // Parse timestamp
    const timestampMs = parseInt(timestampStr, 10);
    if (isNaN(timestampMs)) {
      return reply.status(401).send({ error: 'invalid timestamp' });
    }

    // Check header lengths
    if (nonce.length < 1 || nonce.length > 128 || idempotencyKey.length < 1 || idempotencyKey.length > 128 || signature.length < 1 || signature.length > 128) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    // Check device exists and is active
    const secret = app.deviceSecrets.get(deviceId);
    if (!secret || !app.deviceRepo.isActive(deviceId)) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    // Check clock skew
    const nowMs = Date.now();
    if (Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    // Verify signature
    if (!verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    // Rate limit by device
    const deviceResult = app.rateLimiter.allow('device', deviceId, 120, nowMs);
    if (!deviceResult.allowed) {
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }

    // Parse and validate envelope
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(body.toString('utf-8'));
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
        throw new Error('body must be a JSON object');
      }
    } catch {
      return reply.status(400).send({ error: 'invalid request' });
    }

    // Validate required fields
    const requiredFields = ['schemaVersion', 'deliveryId', 'sourceEventId', 'eventType', 'createdAt', 'payload'];
    for (const field of requiredFields) {
      if (!(field in envelope)) {
        return reply.status(400).send({ error: 'missing envelope fields' });
      }
    }

    // Must be schemaVersion2 (encrypted)
    if (envelope.schemaVersion !== 2) {
      return reply.status(400).send({ error: 'encrypted schemaVersion2 required' });
    }

    // Validate eventType
    const allowedEventTypes = new Set(['INCOMING_SMS', 'NOTIFICATION', 'CALL_STATE', 'CALL_IDENTITY', 'OUTBOUND_SMS_STATUS', 'DEVICE_STATE', 'LOCAL_SELF_TEST']);
    if (!allowedEventTypes.has(envelope.eventType as string)) {
      return reply.status(400).send({ error: 'unsupported eventType' });
    }

    // Decrypt payload
    let decrypted: Record<string, unknown>;
    try {
      const result = decryptPayload(envelope as any, deviceId, secret);
      decrypted = result.payload as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ error: 'invalid encrypted payload' });
    }

    // Record nonce and write event atomically
    let inserted: boolean;
    try {
      // Record nonce first (throws if replayed)
      app.deviceRepo.recordNonce(deviceId, nonce, nowMs);

      // Insert event
      inserted = app.eventRepo.accept(deviceId, idempotencyKey, nonce, envelope, nowMs);
    } catch (error: any) {
      if (error.message === 'replayed nonce') {
        return reply.status(409).send({ error: 'replayed nonce' });
      }
      return reply.status(400).send({ error: error.message || 'invalid request' });
    }

    // Apply side effects based on event type
    try {
      if (envelope.eventType === 'OUTBOUND_SMS_STATUS') {
        app.outboundRepo.updateStatus(deviceId, decrypted, nowMs);
      } else if (envelope.eventType === 'DEVICE_STATE') {
        upsertDeviceState(app.db, deviceId, decrypted, nowMs);
      } else if (envelope.eventType === 'INCOMING_SMS') {
        observeIncomingSms(app.db, deviceId, decrypted, nowMs);
      }

      // Touch device
      app.deviceRepo.touchDevice(deviceId, nowMs);

      // Prune old events
      app.eventRepo.prune(30, nowMs);
    } catch (error: any) {
      // Side effect failures don't fail the request since the event was already written
      app.log.error(error, 'Failed to apply side effects');
    }

    return reply.status(inserted ? 201 : 200).send({
      accepted: true,
      duplicate: !inserted,
    });
  });

  /**
   * POST /v1/device-commands/claim
   *
   * Claim queued outbound SMS commands for one Android gateway.
   * Uses the same device HMAC headers as event ingestion.
   */
  app.post('/v1/device-commands/claim', async (request, reply) => {
    // Rate limit by IP
    const clientIp = request.ip;
    const ipResult = app.rateLimiter.allow('device-auth-ip', clientIp, 120, Date.now());
    if (!ipResult.allowed) {
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }

    // Read body as buffer for signature verification
    const bodyStr2 = JSON.stringify(request.body);
    const body = Buffer.from(bodyStr2, 'utf-8');
    if (!body) {
      return reply.status(400).send({ error: 'invalid request' });
    }

    // Extract and validate headers
    const deviceId = request.headers['x-gateway-device'] as string;
    const nonce = request.headers['x-gateway-nonce'] as string;
    const idempotencyKey = request.headers['idempotency-key'] as string;
    const signature = request.headers['x-gateway-signature'] as string;
    const timestampStr = request.headers['x-gateway-timestamp'] as string;

    if (!deviceId || !nonce || !idempotencyKey || !signature || !timestampStr) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    const timestampMs = parseInt(timestampStr, 10);
    if (isNaN(timestampMs)) {
      return reply.status(401).send({ error: 'invalid timestamp' });
    }

    if (nonce.length < 1 || nonce.length > 128 || idempotencyKey.length < 1 || idempotencyKey.length > 128 || signature.length < 1 || signature.length > 128) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    const secret = app.deviceSecrets.get(deviceId);
    if (!secret || !app.deviceRepo.isActive(deviceId)) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    const nowMs = Date.now();
    if (Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    if (!verifySignature(secret, timestampMs, nonce, deviceId, idempotencyKey, body, signature)) {
      return reply.status(401).send({ error: 'authentication failed' });
    }

    const deviceResult = app.rateLimiter.allow('device', deviceId, 120, nowMs);
    if (!deviceResult.allowed) {
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }

    // Parse request body
    let limit = 5;
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.limit !== undefined) {
          if (typeof parsed.limit !== 'number' || parsed.limit < 1 || parsed.limit > 10) {
            return reply.status(400).send({ error: 'invalid limit' });
          }
          limit = parsed.limit;
        }
      }
    } catch {
      return reply.status(400).send({ error: 'invalid request' });
    }

    // Record nonce
    try {
      app.deviceRepo.recordNonce(deviceId, nonce, nowMs);
    } catch (error: any) {
      if (error.message === 'replayed nonce') {
        return reply.status(409).send({ error: 'replayed nonce' });
      }
      return reply.status(400).send({ error: error.message });
    }

    // Touch device
    app.deviceRepo.touchDevice(deviceId, nowMs);

    // Claim commands
    const commands = app.outboundRepo.claim(deviceId, secret, limit, nowMs);
    return reply.send({ commands });
  });
}

/**
 * Upsert device state from DEVICE_STATE event.
 * Matches the Python gateway's upsert_device_state exactly.
 */
function upsertDeviceState(db: any, deviceId: string, payload: Record<string, unknown>, nowMs: number): void {
  // Validate required boolean fields
  for (const field of ['defaultSmsRole', 'receiveSmsGranted', 'sendSmsGranted', 'readPhoneStateGranted']) {
    if (typeof payload[field] !== 'boolean') {
      throw new Error(`invalid ${field}`);
    }
  }

  const observedAt = payload.observedAt;
  const versionCode = payload.versionCode;
  const targetSdk = payload.targetSdk;

  if (typeof observedAt !== 'number' || observedAt < 0 ||
      typeof versionCode !== 'number' || versionCode < 0 ||
      typeof targetSdk !== 'number' || targetSdk < 1) {
    throw new Error('invalid device state');
  }

  // Validate string fields
  for (const field of ['appVersion', 'androidVersion', 'manufacturer', 'model', 'receiveMode']) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 128) {
      throw new Error('invalid device state');
    }
  }

  if (payload.receiveMode !== 'OBSERVER' && payload.receiveMode !== 'DEFAULT_SMS') {
    throw new Error('invalid receiveMode');
  }

  // Validate receiver diagnostics
  const receiverInvokedAt = payload.receiverInvokedAt;
  const receiverParseFailureAt = payload.receiverParseFailureAt;
  const receiverInvokedAction = payload.receiverInvokedAction;
  const receiverParseFailureReason = payload.receiverParseFailureReason;

  for (const value of [receiverInvokedAt, receiverParseFailureAt]) {
    if (value !== undefined && value !== null && (typeof value !== 'number' || value < 0)) {
      throw new Error('invalid receiver diagnostic');
    }
  }

  if (receiverInvokedAction !== undefined && receiverInvokedAction !== null &&
      receiverInvokedAction !== 'SMS_RECEIVED' && receiverInvokedAction !== 'SMS_DELIVER') {
    throw new Error('invalid receiver diagnostic');
  }

  if (receiverParseFailureReason !== undefined && receiverParseFailureReason !== null &&
      !['NO_MESSAGES', 'PARSER_EXCEPTION', 'PROCESSING_EXCEPTION'].includes(receiverParseFailureReason as string)) {
    throw new Error('invalid receiver diagnostic');
  }

  // Validate lines
  const lines = payload.lines;
  if (!Array.isArray(lines) || lines.length > 4) {
    throw new Error('invalid lines');
  }

  // Upsert device status
  db.prepare(`
    INSERT INTO device_status(
      device_id, observed_at, app_version, version_code, target_sdk,
      android_version, manufacturer, model, receive_mode, default_sms_role,
      receive_sms_granted, send_sms_granted, read_phone_state_granted,
      last_receiver_invoked_at, last_receiver_invoked_action,
      last_receiver_parse_failure_at, last_receiver_parse_failure_reason,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      app_version = excluded.app_version,
      version_code = excluded.version_code,
      target_sdk = excluded.target_sdk,
      android_version = excluded.android_version,
      manufacturer = excluded.manufacturer,
      model = excluded.model,
      receive_mode = excluded.receive_mode,
      default_sms_role = excluded.default_sms_role,
      receive_sms_granted = excluded.receive_sms_granted,
      send_sms_granted = excluded.send_sms_granted,
      read_phone_state_granted = excluded.read_phone_state_granted,
      last_receiver_invoked_at = CASE
        WHEN excluded.last_receiver_invoked_at IS NOT NULL
          AND (device_status.last_receiver_invoked_at IS NULL
               OR excluded.last_receiver_invoked_at >= device_status.last_receiver_invoked_at)
        THEN excluded.last_receiver_invoked_at
        ELSE device_status.last_receiver_invoked_at
      END,
      last_receiver_invoked_action = CASE
        WHEN excluded.last_receiver_invoked_at IS NOT NULL
          AND (device_status.last_receiver_invoked_at IS NULL
               OR excluded.last_receiver_invoked_at >= device_status.last_receiver_invoked_at)
        THEN excluded.last_receiver_invoked_action
        ELSE device_status.last_receiver_invoked_action
      END,
      last_receiver_parse_failure_at = CASE
        WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
          AND (device_status.last_receiver_parse_failure_at IS NULL
               OR excluded.last_receiver_parse_failure_at >= device_status.last_receiver_parse_failure_at)
        THEN excluded.last_receiver_parse_failure_at
        ELSE device_status.last_receiver_parse_failure_at
      END,
      last_receiver_parse_failure_reason = CASE
        WHEN excluded.last_receiver_parse_failure_at IS NOT NULL
          AND (device_status.last_receiver_parse_failure_at IS NULL
               OR excluded.last_receiver_parse_failure_at >= device_status.last_receiver_parse_failure_at)
        THEN excluded.last_receiver_parse_failure_reason
        ELSE device_status.last_receiver_parse_failure_reason
      END,
      updated_at = excluded.updated_at
  `).run(
    deviceId, observedAt, String(payload.appVersion).trim(), versionCode, targetSdk,
    String(payload.androidVersion).trim(), String(payload.manufacturer).trim(),
    String(payload.model).trim(), payload.receiveMode,
    Number(payload.defaultSmsRole), Number(payload.receiveSmsGranted),
    Number(payload.sendSmsGranted), Number(payload.readPhoneStateGranted),
    receiverInvokedAt, receiverInvokedAction,
    receiverParseFailureAt, receiverParseFailureReason,
    nowMs
  );

  // Update device lines
  db.prepare('DELETE FROM device_lines WHERE device_id = ?').run(deviceId);

  for (const line of lines) {
    if (typeof line !== 'object' || line === null) throw new Error('invalid line');
    const slotIndex = line.slotIndex;
    const active = line.active;
    if (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex > 3 || typeof active !== 'boolean') {
      throw new Error('invalid line');
    }
    db.prepare(`
      INSERT INTO device_lines(device_id, slot_index, subscription_id, carrier_name, display_name, is_active, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, slotIndex, line.subscriptionId ?? null, line.carrierName ?? null, line.displayName ?? null, active ? 1 : 0, observedAt);
  }
}

/**
 * Observe incoming SMS from INCOMING_SMS event.
 * Updates device status with last SMS timestamps.
 */
function observeIncomingSms(db: any, deviceId: string, payload: Record<string, unknown>, nowMs: number): void {
  const body = typeof payload.body === 'string' ? payload.body : '';
  const candidates = extractOtpCandidates(body);
  const action = payload.action;
  const validAction = (action === 'SMS_RECEIVED' || action === 'SMS_DELIVER') ? action : null;

  db.prepare(`
    INSERT INTO device_status(
      device_id, observed_at, updated_at,
      last_incoming_sms_at, last_otp_at, last_ordinary_sms_at,
      last_receiver_action, last_receiver_action_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      last_incoming_sms_at = excluded.last_incoming_sms_at,
      last_otp_at = COALESCE(excluded.last_otp_at, device_status.last_otp_at),
      last_ordinary_sms_at = COALESCE(excluded.last_ordinary_sms_at, device_status.last_ordinary_sms_at),
      last_receiver_action = COALESCE(excluded.last_receiver_action, device_status.last_receiver_action),
      last_receiver_action_at = COALESCE(excluded.last_receiver_action_at, device_status.last_receiver_action_at),
      updated_at = excluded.updated_at
  `).run(
    deviceId, nowMs, nowMs,
    nowMs,
    candidates.length > 0 ? nowMs : null,
    candidates.length === 0 ? nowMs : null,
    validAction,
    validAction ? nowMs : null
  );
}