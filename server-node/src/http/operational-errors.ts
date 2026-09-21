const RETRYABLE_SQLITE_CODES = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_INTERRUPT',
] as const;

export class ServiceUnavailableError extends Error {
  readonly statusCode = 503;
  readonly retryAfterMs: number;

  constructor(message = 'service temporarily unavailable', retryAfterMs = 5_000) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class InvalidEventPayloadError extends Error {
  readonly statusCode = 400;

  constructor(message = 'invalid event payload') {
    super(message);
    this.name = 'InvalidEventPayloadError';
  }
}

export function isRetryableSqliteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
  const errcode = 'errcode' in error && typeof error.errcode === 'number'
    ? error.errcode
    : null;
  return RETRYABLE_SQLITE_CODES.some(prefix => code.startsWith(prefix))
    || errcode === 5
    || errcode === 6
    || errcode === 10
    || errcode === 13;
}

export function rethrowOperationalError(error: unknown): never {
  if (isRetryableSqliteError(error)) {
    throw new ServiceUnavailableError();
  }
  throw error;
}
