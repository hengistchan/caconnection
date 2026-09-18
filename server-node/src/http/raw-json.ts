import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function registerRawJsonParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request: FastifyRequest, body: Buffer, done) => {
      request.rawBody = Buffer.from(body);
      try {
        done(null, JSON.parse(body.toString('utf-8')));
      } catch {
        const error = new Error('invalid request') as Error & { statusCode: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );
}
