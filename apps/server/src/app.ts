import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import fastifyStatic from '@fastify/static';
import type { Bus } from './bus.js';
import type { RoomEngine } from './engine/room.js';
import type { KeyRow, Storage } from './storage/types.js';
import type { Config } from './config.js';
import { sha256 } from './ids.js';
import { bearerKey } from './http/auth.js';
import { registerKeyRoutes } from './http/routes-keys.js';
import { registerRoomRoutes } from './http/routes-rooms.js';
import { registerSocialRoutes } from './http/routes-social.js';
import { registerAdminRoutes } from './http/routes-admin.js';
import { registerOwnerRoutes } from './http/routes-owner.js';

export interface AppDeps {
  storage: Storage;
  engine: RoomEngine;
  bus: Bus;
  config: Config;
  // 结构类型内联声明，避免 app.ts ↔ ws 目录循环 import（compose 传实例，纯 REST 测试可传 null）
  agentGateway?: { forceDisconnect(id: string): void; onlineCount(): number } | null;
  humanGateway?: { onlineCount(): number } | null;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: deps.config.trustProxy });
  app.decorate('deps', deps);
  // 软鉴权：有合法 Bearer key 就挂到 req.key（不拒绝匿名），供 GET 只读路由按身份过滤。
  app.addHook('onRequest', async (req) => {
    const raw = bearerKey(req);
    if (!raw) return;
    const key = deps.storage.getKeyByHash(sha256(raw));
    if (key && key.status === 'active') req.key = key;
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_request' });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
  // CSP：页面同源自给，组件内联 style 放行，WS 跨 scheme 放行；全局 onSend 保证静态页也带上。
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // 组件内联 style 属性
    "connect-src 'self' ws: wss:", // WS 与 API 同源
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; ');
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Content-Security-Policy', CSP);
  });
  registerKeyRoutes(app, deps);
  registerRoomRoutes(app, deps);
  registerSocialRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerOwnerRoutes(app, deps);
  registerStatic(app);
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    key?: KeyRow;
  }
}

function registerStatic(app: FastifyInstance): void {
  const distDir = join(process.cwd(), 'apps', 'web', 'dist');
  if (!existsSync(distDir)) return;
  void app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.type('text/html').send(readFileSync(join(distDir, 'index.html')));
  });
}
