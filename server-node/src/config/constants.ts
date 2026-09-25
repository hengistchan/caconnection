export const SERVICE_VERSION = '0.8.0';

// API and protocol versions — must remain identical to Python
export const API_VERSION = 1;
export const PROTOCOL_SCHEMA_VERSION = 2;

// Body and header limits
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_CLOCK_SKEW_MS = 300_000;
export const NONCE_RETENTION_MS = 600_000;

// Defaults
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_OTP_MAX_AGE_SECONDS = 600;
export const DEFAULT_INGEST_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_DEVICE_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_API_AUTH_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_API_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_PAIRING_CREATE_REQUESTS_PER_MINUTE = 20;
export const DEFAULT_PAIRING_CLAIM_REQUESTS_PER_MINUTE = 20;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
export const DEFAULT_OUTBOUND_COMMAND_EXPIRES_SECONDS = 300;
// Command lease must be well below MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS:
// requeue requires expires_at > now, so a lease >= TTL leaves no recovery
// window at all and a crashed client strands the command until expiry.
export const OUTBOUND_COMMAND_LEASE_MS = 30 * 1000;
// DISPATCHING straddles the external SmsManager call. After this window its
// result becomes unknown, but late callbacks remain authoritative.
export const OUTBOUND_DISPATCH_SETTLE_MS = 2 * 60 * 1000;
// A command in SENT_TO_MODEM with no delivery report becomes OUTCOME_UNKNOWN
// after this idle period. A late delivery callback may still correct it.
export const OUTBOUND_SENT_SETTLE_MS = 10 * 60 * 1000;
export const DEFAULT_NOTIFICATION_RETRY_SECONDS = 5;
export const MAX_NOTIFICATION_RETRY_SECONDS = 15 * 60;
export const MAX_NOTIFICATION_DELIVERY_ATTEMPTS = 4;
export const NOTIFICATION_DELIVERY_LEASE_MS = 60_000;
export const CALL_NOTIFICATION_IDENTITY_WAIT_MS = 30_000;
export const CALL_IDENTITY_CORRELATION_WINDOW_MS = 10_000;

// Device health windows
export const DEVICE_ONLINE_WINDOW_MS = 3 * 60 * 1000;
export const DEVICE_STALE_WINDOW_MS = 15 * 60 * 1000;

// Outbound
export const MIN_OUTBOUND_COMMAND_EXPIRES_SECONDS = 60;
export const MAX_OUTBOUND_COMMAND_EXPIRES_SECONDS = 3600;

// Pairing
export const MIN_PAIRING_EXPIRES_SECONDS = 60;
export const MAX_PAIRING_EXPIRES_SECONDS = 600;

// Rate limiting
export const MAX_RATE_LIMIT_IDENTITIES = 10_000;

// Allowed event types — must match Python exactly
export const ALLOWED_EVENT_TYPES = new Set([
  'INCOMING_SMS',
  'NOTIFICATION',
  'CALL_STATE',
  'CALL_IDENTITY',
  'OUTBOUND_SMS_STATUS',
  'DEVICE_STATE',
  'LOCAL_SELF_TEST',
]);

// Outbound command statuses
export const OUTBOUND_COMMAND_STATUSES = new Set([
  'QUEUED',
  'CLAIMED',
  'CREATED',
  'DISPATCHING',
  'OUTCOME_UNKNOWN',
  'SENT_TO_MODEM',
  'DELIVERED',
  'FAILED',
  'EXPIRED',
]);

// Status ordering for monotonic updates
export const OUTBOUND_STATUS_ORDER: Record<string, number> = {
  QUEUED: 0,
  CLAIMED: 1,
  CREATED: 2,
  DISPATCHING: 3,
  OUTCOME_UNKNOWN: 4,
  SENT_TO_MODEM: 4,
  DELIVERED: 5,
  FAILED: 5,
  EXPIRED: 5,
};

// Valid API scopes
export const VALID_SCOPES = new Set([
  'messages:read',
  'messages:send',
  'otp:claim',
  'pairing:create',
  'devices:read',
  'devices:write',
  'notifications:manage',
  '*',
]);

export const NOTIFICATION_CONTENT_MODES = new Set(['REDACTED', 'FULL']);
export const NOTIFICATION_EVENT_TYPES = new Set(['INCOMING_SMS', 'NOTIFICATION', 'CALL_STATE']);
export const NOTIFICATION_CHANNEL_EVENT_TYPES = new Set([
  'sms.received',
  'call.ringing',
  'call.missed',
  'call.ended',
  'notification.received',
]);

// Receiver diagnostic values
export const RECEIVER_INVOKED_ACTIONS = new Set(['SMS_RECEIVED', 'SMS_DELIVER']);
export const RECEIVER_PARSE_FAILURE_REASONS = new Set([
  'NO_MESSAGES',
  'PARSER_EXCEPTION',
  'PROCESSING_EXCEPTION',
]);

// Receive modes
export const RECEIVE_MODES = new Set(['OBSERVER', 'DEFAULT_SMS']);
