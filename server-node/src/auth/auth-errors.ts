/**
 * Authentication error types.
 */

export class AuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class RateLimitError extends Error {
  readonly statusCode = 429;
  retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ReplayedNonceError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('replayed nonce');
    this.name = 'ReplayedNonceError';
  }
}
