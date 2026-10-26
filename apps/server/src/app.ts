import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Bus } from './bus.js';
import type { RoomEngine } from './engine/room.js';
import type { Storage } from './storage/types.js';
import type { Config } from './config.js';

export interface AppDeps {
  storage: Storage;
  engine: RoomEngine;
  bus: Bus;
  config: Config;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate('deps', deps);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_request' });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
