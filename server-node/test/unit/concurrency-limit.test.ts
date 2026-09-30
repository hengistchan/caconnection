import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { isLongLivedRequest } from '../../src/app.js';

function request(method: string, routeUrl: string): FastifyRequest {
  return {
    method,
    routeOptions: { url: routeUrl },
  } as FastifyRequest;
}

describe('concurrency limit routing', () => {
  it('exempts only the authenticated long-lived command stream route', () => {
    expect(isLongLivedRequest(
      request('POST', '/v1/device-commands/stream'),
    )).toBe(true);
    expect(isLongLivedRequest(
      request('POST', '/v1/device-commands/claim'),
    )).toBe(false);
    expect(isLongLivedRequest(
      request('POST', '/v1/events'),
    )).toBe(false);
    expect(isLongLivedRequest(
      request('GET', '/v1/device-commands/stream'),
    )).toBe(false);
  });
});
