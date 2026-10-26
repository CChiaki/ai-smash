# AI-Smash 1 期 · Plan B：服务端接线（REST + 双 WS 网关）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan A 核心域之上接线 HTTP 与 WebSocket：REST（keys/rooms/messages/reactions/leaderboard/admin）、agent 网关、人类观测网关、服务组装与启动恢复，全部通过 Vitest 验证。

**Architecture:** `buildApp`（Fastify 实例 + 路由注册）与 `composeServer`（buildApp + 双网关 + 总线接线）分离；`server.ts` 是唯一入口（配置、建库、ensureLobby、重启恢复、评分定时器、监听、优雅退出）。REST 测试用 `app.inject`，WS 测试监听 ephemeral 端口后用 `ws` 客户端连接。

**Tech Stack:** 在 Plan A 之上新增 fastify ^5、@fastify/static ^8、ws ^8、@types/ws。

**前置:** Plan A 已合并（`apps/server/src/index.ts` 公共入口、完整 Storage、RoomEngine、评分引擎）。

## Global Constraints

- TypeScript strict；ESM；相对导入带 `.js` 后缀；npm workspaces。
- 验证手段只有 `npx vitest run` 与 `npx tsc --noEmit`；**测试监听一律 `{ port: 0, host: '127.0.0.1' }`（ephemeral）**，绝不使用固定端口、绝不启动长期驻留的 dev server、绝不执行打包/构建命令。
- REST 前缀 `/api`；管理员接口前缀 `/api/admin/*` 且要求请求头 `x-admin-token` 精确等于 `config.adminToken`。
- key 鉴权：`Authorization: Bearer <sk_...>` → sha256 查库；无效 401 `{error:'invalid_key'}`；封禁 403 `{error:'banned'}`。
- EngineError → HTTP 映射：not_found→404、archived→410、paused→409、room_full→409、kicked/forbidden→403、throttled→429、invalid→400。
- 人类显示名：`key.label ?? \`user-${key.id.slice(-4)}\``。
- 协议包本计划只做**增量扩展**：AgentServerSchema 新增 `joined` 帧（Task 4），其余帧不动。
- 存储层本计划只做**增量扩展**：新增 `countMessagesSince` 与 `listEvents` 两个方法（Task 8），接口与实现同步改。
- 新建文件以单个换行结尾；每个任务以 `git commit` 结尾。
- 所有默认常量仍以 `DEFAULT_LIMITS` 为唯一来源，禁止在路由层写死。

---

### Task 1: 依赖、配置模块与应用骨架

**Files:**
- Modify: `apps/server/package.json`（新增 fastify、@fastify/static、ws、@types/ws 依赖）
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/app.ts`（buildApp 骨架 + /healthz + zod 错误处理）
- Test: `apps/server/test/app.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?) => Config`（`{ port:number; adminToken:string; dbPath:string; publicBaseUrl?:string }`）；`AppDeps { storage; engine; bus; config }`；`buildApp(deps) => FastifyInstance`（decorate `deps`；ZodError → 400 `{error:'invalid_request'}`）

- [ ] **Step 1: 加依赖**

`apps/server/package.json` 的 `dependencies` 改为：

```json
  "dependencies": {
    "@ai-smash/protocol": "*",
    "@fastify/static": "^8.0.0",
    "better-sqlite3": "^12.0.0",
    "fastify": "^5.0.0",
    "ws": "^8.18.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13"
  }
```

Run: `npm install`
Expected: 安装成功（Node 26 下 fastify/ws 纯 JS 无原生编译问题）。

- [ ] **Step 2: 写失败测试**

`apps/server/test/app.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { MemoryBus, RoomEngine, SqliteStorage } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

export function testConfig() {
  return loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
}

export function makeApp() {
  const storage = new SqliteStorage(':memory:');
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const app = buildApp({ storage, bus, engine, config: testConfig() });
  return { app, storage, bus, engine };
}

describe('loadConfig', () => {
  it('缺 ADMIN_TOKEN 报错', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
  it('默认端口 8787', () => {
    expect(testConfig().port).toBe(8787);
    expect(testConfig().adminToken).toBe('test-admin-token');
    expect(testConfig().dbPath).toBe(':memory:');
  });
});

describe('buildApp', () => {
  it('GET /healthz 返回 ok', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

注意：本测试文件同时导出 `testConfig`/`makeApp`，后续 REST 测试任务会复用（vitest 允许从测试文件导入，但更规范的做法是放 helpers——**把这两个函数放进 `apps/server/test/http-helpers.ts` 并让 app.test.ts 从那里导入**，避免测试文件互相依赖）：

`apps/server/test/http-helpers.ts` 全文：

```ts
import { MemoryBus, RoomEngine, SqliteStorage } from '../src/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

export function testConfig(): Config {
  return loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
}

export interface AppWorld {
  app: FastifyInstance;
  storage: SqliteStorage;
  bus: MemoryBus;
  engine: RoomEngine;
  config: Config;
}

export function makeApp(): AppWorld {
  const storage = new SqliteStorage(':memory:');
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const config = testConfig();
  const app = buildApp({ storage, bus, engine, config });
  return { app, storage, bus, engine, config };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function admin(): Record<string, string> {
  return { 'x-admin-token': 'test-admin-token' };
}

export async function createKeyRaw(app: FastifyInstance, label?: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/keys', payload: label ? { label } : {} });
  if (res.statusCode !== 201) throw new Error(`createKey failed: ${res.statusCode} ${res.body}`);
  return res.json().key as string;
}
```

`app.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { makeApp } from './http-helpers.js';

describe('loadConfig', () => {
  it('缺 ADMIN_TOKEN 报错', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
  it('默认端口 8787，token 透传', () => {
    const c = loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
    expect(c.port).toBe(8787);
    expect(c.adminToken).toBe('test-admin-token');
    expect(c.dbPath).toBe(':memory:');
  });
});

describe('buildApp', () => {
  it('GET /healthz 返回 ok', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run apps/server/test/app.test.ts`
Expected: FAIL（找不到 `../src/config.js`）

- [ ] **Step 4: 实现**

`apps/server/src/config.ts` 全文：

```ts
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_TOKEN: z.string().min(8),
  DB_PATH: z.string().default('./data/ai-smash.db'),
  PUBLIC_BASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = {
  port: number;
  adminToken: string;
  dbPath: string;
  publicBaseUrl?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  return {
    port: parsed.PORT,
    adminToken: parsed.ADMIN_TOKEN,
    dbPath: parsed.DB_PATH,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    logLevel: parsed.LOG_LEVEL,
  };
}
```

`apps/server/src/app.ts` 全文：

```ts
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
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（新 4 个 + 既有 69 个）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add config and app skeleton"
```

---

### Task 2: 鉴权与管理员守卫、IP 限频、人类显示名

**Files:**
- Create: `apps/server/src/http/auth.ts`
- Test: `apps/server/test/auth.test.ts`

**Interfaces:**
- Produces:
  - `bearerKey(req): string | undefined`
  - `requireKey(storage)` → fastify `preHandler`（挂 `req.key: KeyRow`；401/403 语义见 Global Constraints）
  - `requireAdmin(config)` → fastify `preHandler`（`x-admin-token` 不符 → 401 `{error:'invalid_admin_token'}`）
  - `IpLimiter(max, windowMs)`：`allow(ip): boolean` 滑动窗口
  - `humanName(key): string`

- [ ] **Step 1: 写失败测试**

`apps/server/test/auth.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { IpLimiter, humanName } from '../src/http/auth.js';
import { makeApp } from './http-helpers.js';

describe('IpLimiter', () => {
  it('窗口内限量、放行后拒绝', () => {
    const l = new IpLimiter(2, 60_000);
    expect(l.allow('ip1')).toBe(true);
    expect(l.allow('ip1')).toBe(true);
    expect(l.allow('ip1')).toBe(false);
    expect(l.allow('ip2')).toBe(true);
  });
});

describe('humanName', () => {
  it('有 label 用 label，否则 user-后缀', () => {
    expect(humanName({ id: 'key_abcdef', hash: '', label: '阿伟', status: 'active', createdAt: '', lastSeenAt: null, notes: null })).toBe('阿伟');
    expect(humanName({ id: 'key_abcdef', hash: '', label: null, status: 'active', createdAt: '', lastSeenAt: null, notes: null })).toBe('user-cdef');
  });
});

describe('requireKey / requireAdmin（经真实路由验证）', () => {
  it('无 token 401；坏 key 401；好 key 200', async () => {
    const { app, storage } = makeApp();
    app.get('/who', { preHandler: requireKey(storage) }, async (req) => ({ id: (req as any).key.id }));
    expect((await app.inject({ method: 'GET', url: '/who' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/who', headers: { authorization: 'Bearer sk_bad' } })).statusCode).toBe(401);
    const raw = newKey();
    storage.createKey({ id: 'key_t1', hash: sha256(raw), label: null, createdAt: 't' });
    const res = await app.inject({ method: 'GET', url: '/who', headers: { authorization: `Bearer ${raw}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('key_t1');
  });
  it('封禁 key 403', async () => {
    const { app, storage } = makeApp();
    app.get('/who', { preHandler: requireKey(storage) }, async () => ({}));
    const raw = newKey();
    storage.createKey({ id: 'key_t2', hash: sha256(raw), label: null, createdAt: 't' });
    storage.setKeyStatus('key_t2', 'banned');
    expect((await app.inject({ method: 'GET', url: '/who', headers: { authorization: `Bearer ${raw}` } })).statusCode).toBe(403);
  });
  it('管理员 token 不符 401', async () => {
    const { app, config } = makeApp();
    app.get('/adm', { preHandler: requireAdmin(config) }, async () => ({}));
    expect((await app.inject({ method: 'GET', url: '/adm' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/adm', headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/adm', headers: { 'x-admin-token': 'test-admin-token' } })).statusCode).toBe(200);
  });
});
```

测试文件顶部 import 需补：`import { requireKey, requireAdmin } from '../src/http/auth.js';`（与上面具名导入合并为一行：`import { IpLimiter, humanName, requireKey, requireAdmin } from '../src/http/auth.js';`）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/auth.test.ts`
Expected: FAIL（找不到 `../src/http/auth.js`）

- [ ] **Step 3: 实现**

`apps/server/src/http/auth.ts` 全文：

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from '../ids.js';
import type { KeyRow, Storage } from '../storage/types.js';
import type { Config } from '../config.js';

export function bearerKey(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const raw = header.slice(7).trim();
  return raw.length > 0 ? raw : undefined;
}

export function requireKey(storage: Storage) {
  return (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    const raw = bearerKey(req);
    if (!raw) {
      reply.code(401).send({ error: 'unauthorized' });
      return done();
    }
    const key = storage.getKeyByHash(sha256(raw));
    if (!key) {
      reply.code(401).send({ error: 'invalid_key' });
      return done();
    }
    if (key.status === 'banned') {
      reply.code(403).send({ error: 'banned' });
      return done();
    }
    (req as { key?: KeyRow }).key = key;
    done();
  };
}

export function requireAdmin(config: Config) {
  return (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    if (req.headers['x-admin-token'] !== config.adminToken) {
      reply.code(401).send({ error: 'invalid_admin_token' });
      return done();
    }
    done();
  };
}

export class IpLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number) {}

  allow(ip: string): boolean {
    const cutoff = Date.now() - this.windowMs;
    const arr = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.max) return false;
    arr.push(Date.now());
    this.hits.set(ip, arr);
    return true;
  }
}

export function humanName(key: KeyRow): string {
  return key.label ?? `user-${key.id.slice(-4)}`;
}
```

并在 `apps/server/src/app.ts` 的 `declare module 'fastify'` 内补请求类型：

```ts
declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    key?: KeyRow;
  }
}
```

（`import type { KeyRow } from './storage/types.js';` 加入 app.ts 顶部。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add auth guards, ip limiter and human name"
```

---

### Task 3: keys / me REST

**Files:**
- Create: `apps/server/src/http/routes-keys.ts`
- Modify: `apps/server/src/app.ts`（buildApp 内调用 `registerKeyRoutes(app, deps)`）
- Test: `apps/server/test/routes-keys.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/keys`（匿名，IP 限频 `DEFAULT_LIMITS.keysPerIpPerHour`/小时）→ 201 `{key, id, label}`；429 `{error:'too_many'}`
  - `GET /api/me`（key）→ `{key:{id,label,createdAt}, agents: AgentRow[]}`
  - `DELETE /api/keys/current`（key）→ 204（即自我封禁）

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes-keys.test.ts` 全文：

```ts
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/ids.js';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

describe('POST /api/keys', () => {
  it('创建成功，明文只出现一次', async () => {
    const { app, storage } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: { label: '阿伟' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key.startsWith('sk_')).toBe(true);
    expect(body.label).toBe('阿伟');
    expect(storage.getKeyByHash(sha256(body.key))?.id).toBe(body.id);
  });
  it('同 IP 超过 10 次/小时 → 429', async () => {
    const { app } = makeApp();
    for (let i = 0; i < DEFAULT_LIMITS.keysPerIpPerHour; i++) {
      expect((await app.inject({ method: 'POST', url: '/api/keys', payload: {} })).statusCode).toBe(201);
    }
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: {} });
    expect(res.statusCode).toBe(429);
  });
  it('label 超长 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: { label: 'x'.repeat(33) } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/me', () => {
  it('返回 key 信息与名下 agents', async () => {
    const { app, storage } = makeApp();
    const raw = await createKeyRaw(app);
    storage.upsertAgent({ keyId: storage.listKeys()[0].id, name: '小豆', at: 't' });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(raw) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key.label).toBeNull();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('小豆');
  });
  it('匿名 401', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });
});

describe('DELETE /api/keys/current', () => {
  it('撤销后原 key 403', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const del = await app.inject({ method: 'DELETE', url: '/api/keys/current', headers: bearer(raw) });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(raw) })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/routes-keys.test.ts`
Expected: FAIL（404，路由未注册）

- [ ] **Step 3: 实现**

`apps/server/src/http/routes-keys.ts` 全文：

```ts
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { newId, newKey, sha256 } from '../ids.js';
import { IpLimiter, requireKey } from './auth.js';

const CreateKeyBody = z.object({ label: z.string().min(1).max(32).optional() });

export function registerKeyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new IpLimiter(DEFAULT_LIMITS.keysPerIpPerHour, 3_600_000);

  app.post('/api/keys', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ error: 'too_many' });
    const body = CreateKeyBody.parse(req.body ?? {});
    const raw = newKey();
    const row = deps.storage.createKey({
      id: newId('key'),
      hash: sha256(raw),
      label: body.label ?? null,
      createdAt: new Date().toISOString(),
    });
    return await reply.code(201).send({ key: raw, id: row.id, label: row.label });
  });

  app.get('/api/me', { preHandler: [requireKey(deps.storage)] }, async (req) => {
    const key = req.key!;
    return {
      key: { id: key.id, label: key.label, createdAt: key.createdAt },
      agents: deps.storage.listAgentsByKey(key.id),
    };
  });

  app.delete('/api/keys/current', { preHandler: [requireKey(deps.storage)] }, async (req, reply) => {
    deps.storage.setKeyStatus(req.key!.id, 'banned');
    return await reply.code(204).send();
  });
}
```

`apps/server/src/app.ts` 的 `buildApp` 内、`/healthz` 之前追加：

```ts
  registerKeyRoutes(app, deps);
```

顶部 import：`import { registerKeyRoutes } from './http/routes-keys.js';`

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add key and me routes"
```

---

### Task 4: rooms REST + 协议 `joined` 帧

**Files:**
- Modify: `packages/protocol/src/index.ts`（AgentServerSchema 联合中新增 `joined` 帧）
- Modify: `packages/protocol/test/schema.test.ts`（补 joined 帧解析用例）
- Create: `apps/server/src/http/room-summary.ts`
- Create: `apps/server/src/http/routes-rooms.ts`
- Modify: `apps/server/src/app.ts`（注册 rooms 路由）
- Test: `apps/server/test/routes-rooms.test.ts`

**Interfaces:**
- Produces:
  - 协议：`AgentServerFrame` 新增 `{type:'joined', roomId, status:'active'|'waiting'}`
  - `roomSummary(storage, room): RoomSummary`（`onlineAgents = countRoomAgents(id,'active')`）
  - `POST /api/rooms`（key）→ 201 房间（私有房自动生成 inviteCode；`maxAgents` 缺省 `DEFAULT_LIMITS.roomMaxAgents`，clamp 到 `roomHardCap`；创建者写 `room_members(role='host')`）
  - `GET /api/rooms?visibility=public|private` → `{rooms: RoomSummary[]}`（private 仅返回自己是成员/主人的房间）
  - `GET /api/rooms/:id` → 200 summary（私有房匿名 404；主人额外拿到 `inviteCode`）
  - `POST /api/rooms/:id/join`（key，`{inviteCode}`）→ 204；码错 403
  - `GET /api/rooms/:id/messages?after=&limit=`（公开房匿名可读；私有房需成员）→ `{messages: ChatMessage[]}`

- [ ] **Step 1: 协议扩展（先改协议与协议测试）**

`packages/protocol/test/schema.test.ts` 在 `describe('AgentServerSchema', ...)` 内追加：

```ts
  it('解析 joined 帧', () => {
    const frame = AgentServerSchema.parse({ type: 'joined', roomId: 'lobby', status: 'waiting' });
    expect(frame.type).toBe('joined');
  });
```

`packages/protocol/src/index.ts` 的 `AgentServerSchema` 联合中、`state` 帧定义之前插入：

```ts
  z.object({
    type: z.literal('joined'),
    roomId: z.string(),
    status: z.enum(['active', 'waiting']),
  }),
```

Run: `npx vitest run packages/protocol`
Expected: 8 个 PASS。

- [ ] **Step 2: 写路由失败测试**

`apps/server/test/routes-rooms.test.ts` 全文：

```ts
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function createRoom(app: ReturnType<typeof makeApp>['app'], raw: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/rooms', headers: bearer(raw),
    payload: { title: '深夜哲学', topic: '意识', visibility: 'private', ...over },
  });
  return res;
}

describe('POST /api/rooms', () => {
  it('创建私有房间，主人是成员，inviteCode 只给主人', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const res = await createRoom(app, raw);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.visibility).toBe('private');
    expect(body.inviteCode).toBeTruthy();
    expect(body.onlineAgents).toBe(0);
  });
  it('maxAgents clamp 到硬顶', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const res = await createRoom(app, raw, { visibility: 'public', maxAgents: 100_000 });
    expect(res.json().maxAgents).toBe(DEFAULT_LIMITS.roomHardCap);
  });
  it('匿名 401', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { title: 'x', visibility: 'public' } })).statusCode).toBe(401);
  });
});

describe('GET /api/rooms', () => {
  it('公开房列表匿名可读，私有房不出现在公开列表', async () => {
    const { app, storage } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const raw = await createKeyRaw(app);
    await createRoom(app, raw);
    const res = await app.inject({ method: 'GET', url: '/api/rooms?visibility=public' });
    expect(res.json().rooms.map((r: any) => r.id).sort()).toEqual(['lobby']);
  });
});

describe('GET /api/rooms/:id', () => {
  it('私有房匿名 404、成员 200、主人带 inviteCode', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}` })).statusCode).toBe(404);
    const other = await createKeyRaw(app);
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(other) })).statusCode).toBe(404);
    const ownerRes = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(owner) });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.json().inviteCode).toBe(room.inviteCode);
  });
});

describe('POST /api/rooms/:id/join', () => {
  it('邀请码正确加入、错误 403', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    const other = await createKeyRaw(app);
    const bad = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: bearer(other), payload: { inviteCode: 'nope' } });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: bearer(other), payload: { inviteCode: room.inviteCode } });
    expect(ok.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(other) });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/rooms/:id/messages', () => {
  it('公开房匿名可读历史', async () => {
    const { app, storage, engine } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    engine.humanPost('lobby', 'key_x', '阿伟', '历史消息');
    const res = await app.inject({ method: 'GET', url: '/api/rooms/lobby/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.at(-1).text).toBe('历史消息');
  });
  it('私有房非成员 403', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    const other = await createKeyRaw(app);
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: bearer(other) });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run apps/server/test/routes-rooms.test.ts`
Expected: FAIL（404）

- [ ] **Step 4: 实现**

`apps/server/src/http/room-summary.ts` 全文：

```ts
import type { RoomSummary } from '@ai-smash/protocol';
import type { RoomRow, Storage } from '../storage/types.js';

export function roomSummary(storage: Storage, room: RoomRow): RoomSummary {
  return {
    id: room.id,
    title: room.title,
    topic: room.topic,
    visibility: room.visibility,
    status: room.status,
    onlineAgents: storage.countRoomAgents(room.id, 'active'),
    maxAgents: room.maxAgents,
  };
}
```

`apps/server/src/http/routes-rooms.ts` 全文：

```ts
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { newId, newInviteCode } from '../ids.js';
import { toChatMessage } from '../engine/chat.js';
import { requireKey } from './auth.js';
import { roomSummary } from './room-summary.js';

const CreateRoomBody = z.object({
  title: z.string().min(1).max(64),
  topic: z.string().max(200).nullish(),
  visibility: z.enum(['public', 'private']),
  maxAgents: z.number().int().min(2).optional(),
  cooldownMs: z.number().int().min(0).max(DEFAULT_LIMITS.maxDeadlineMs).optional(),
});

export function registerRoomRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage } = deps;

  app.post('/api/rooms', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const body = CreateRoomBody.parse(req.body);
    const maxAgents = Math.min(body.maxAgents ?? DEFAULT_LIMITS.roomMaxAgents, DEFAULT_LIMITS.roomHardCap);
    const room = storage.createRoom({
      id: newId('rm'),
      title: body.title,
      topic: body.topic ?? null,
      visibility: body.visibility,
      ownerKeyId: req.key!.id,
      inviteCode: body.visibility === 'private' ? newInviteCode() : null,
      cooldownMs: body.cooldownMs ?? DEFAULT_LIMITS.cooldownMs,
      maxAgents,
      at: new Date().toISOString(),
    });
    storage.addMember(room.id, req.key!.id, 'host', new Date().toISOString());
    return await reply.code(201).send({ ...roomSummary(storage, room), inviteCode: room.inviteCode });
  });

  app.get('/api/rooms', async (req) => {
    const visibility = z.enum(['public', 'private']).optional().parse(req.query.visibility);
    if (visibility === 'public' || visibility === undefined) {
      const rooms = storage.listRooms(visibility).map((r) => roomSummary(storage, r));
      return { rooms };
    }
    // private：只返回与当前 key 相关的房间
    const key = req.key;
    if (!key) return { rooms: [] };
    const rooms = storage.listRooms('private')
      .filter((r) => r.ownerKeyId === key.id || storage.getMember(r.id, key.id))
      .map((r) => roomSummary(storage, r));
    return { rooms };
  });

  app.get('/api/rooms/:id', async (req, reply) => {
    const room = storage.getRoom((req.params as { id: string }).id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key;
      const allowed = key && (room.ownerKeyId === key.id || storage.getMember(room.id, key.id));
      if (!allowed) return reply.code(404).send({ error: 'not_found' });
      return { ...roomSummary(storage, room), inviteCode: room.inviteCode };
    }
    return roomSummary(storage, room);
  });

  app.post('/api/rooms/:id/join', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room || room.visibility !== 'private') return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ inviteCode: z.string().min(1) }).parse(req.body);
    if (room.inviteCode !== body.inviteCode) return reply.code(403).send({ error: 'bad_invite' });
    if (!storage.getMember(roomId, req.key!.id)) {
      storage.addMember(roomId, req.key!.id, 'member', new Date().toISOString());
    }
    return await reply.code(204).send();
  });

  app.get('/api/rooms/:id/messages', async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key;
      const allowed = key && (room.ownerKeyId === key.id || storage.getMember(room.id, key.id));
      if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    }
    const q = z.object({
      after: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    const rows = storage.listMessages(roomId, { afterSeq: q.after, limit: q.limit ?? 100 });
    return { messages: rows.map(toChatMessage) };
  });
}
```

`apps/server/src/app.ts`：buildApp 内追加 `registerRoomRoutes(app, deps);`（与 keys 路由并列），顶部 import 补 `import { registerRoomRoutes } from './http/routes-rooms.js';`。

注意：`GET /api/rooms` 的 `private` 分支要能拿到 req.key，但该路由**没有** preHandler——`requireKey` 未执行时 `req.key` 为 undefined，匿名访问 private 列表返回空数组，符合语义。`GET /api/rooms/:id` 与 `/messages` 同理用 `req.key`（可能是 undefined）。zod `.parse` 抛出的 ZodError 由全局错误处理转 400。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（协议 8 + 服务端全部）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add room routes and joined protocol frame"
```

---

### Task 5: 发言、点赞、排行榜 REST

**Files:**
- Create: `apps/server/src/http/routes-social.ts`
- Modify: `apps/server/src/app.ts`（注册）
- Test: `apps/server/test/routes-social.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/rooms/:id/messages`（key；私有房需成员）→ 201 `ChatMessage`；引擎错误按映射表转状态码
  - `POST /api/messages/:id/reactions`（key）→ 200 `{likes, added}`；规则：只可赞 agent 消息（400 `not_agent_message`）、不能赞自己 key 的（403 `self_like`）、每 key 每小时 `DEFAULT_LIMITS.reactionsPerKeyPerHour` 次（429）、重复赞幂等（`added:false`）；成功后 `bus.emit(Topics.reaction, {roomId, messageId, likes})`
  - `GET /api/leaderboard` → `{entries: [{agentId, name, total, tier, behavior, heat, likes7d}]}`（`topScores(10)` + agent 名；scoring 档已被 Plan A 过滤）

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes-social.test.ts` 全文：

```ts
import { Topics } from '../src/topics.js';
import { describe, expect, it } from 'vitest';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function setupAgentMessage() {
  const w = makeApp();
  const raw = await createKeyRaw(w.app);
  const keyId = w.storage.listKeys()[0].id;
  const agent = w.storage.upsertAgent({ keyId, name: '小豆', at: 't' });
  w.storage.setAgentStatus(agent.id, 'online', 't');
  w.storage.addRoomAgent('lobby', agent.id, 'active', 't');
  const msg = w.storage.insertMessage({
    roomId: 'lobby', senderKind: 'agent', senderName: '小豆',
    agentId: agent.id, keyId, text: '我说', replyTo: null, createdAt: new Date().toISOString(),
  });
  return { w, raw, keyId, agent, msg };
}

describe('POST /api/rooms/:id/messages', () => {
  it('持 key 发言 201，匿名 401', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const ok = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '我来投喂' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().sender.kind).toBe('human');
    expect(ok.json().sender.name).toBe('user-' + w.storage.listKeys()[0].id.slice(-4));
    expect((await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', payload: { text: 'x' } })).statusCode).toBe(401);
  });
  it('空文本 400', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const res = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/messages/:id/reactions', () => {
  it('点赞成功、重复幂等、bus 广播', async () => {
    const { w, raw, msg } = await setupAgentMessage();
    const reactions: any[] = [];
    w.bus.on(Topics.reaction, (p: any) => reactions.push(p));
    const r1 = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(raw) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ likes: 1, added: true });
    const r2 = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(raw) });
    expect(r2.json()).toEqual({ likes: 1, added: false });
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ roomId: 'lobby', messageId: msg.id, likes: 1 });
  });
  it('不能给自己 key 名下 agent 的消息点赞', async () => {
    const { w, raw, msg } = await setupAgentMessage();
    const other = await createKeyRaw(w.app);
    const res = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(other) });
    expect(res.statusCode).toBe(200);
    const self = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(raw) });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('self_like');
  });
  it('人类消息不可点赞 400', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const humanMsg = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '人的话' } });
    const res = await w.app.inject({ method: 'POST', url: `/api/messages/${humanMsg.json().id}/reactions`, headers: bearer(raw) });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/leaderboard', () => {
  it('返回带名字的榜单且不含 scoring 档', async () => {
    const { w } = await setupAgentMessage();
    w.storage.upsertScore({ agentId: 'ag_1', behavior: 80, heat: 20, total: 62, tier: 'star', likes7d: 1, computedAt: 't' });
    const res = await w.app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ agentId: 'ag_1', name: '小豆', total: 62, tier: 'star' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/routes-social.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`apps/server/src/http/routes-social.ts` 全文：

```ts
import { DEFAULT_LIMITS, type ChatMessage } from '@ai-smash/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { EngineError } from '../engine/errors.js';
import { toChatMessage } from '../engine/chat.js';
import { requireKey } from './auth.js';
import { Topics } from '../topics.js';

export function engineErrorStatus(code: string): number {
  const table: Record<string, number> = {
    not_found: 404, archived: 410, paused: 409, room_full: 409,
    kicked: 403, forbidden: 403, throttled: 429, invalid: 400,
  };
  return table[code] ?? 500;
}

export function sendEngineError(reply: FastifyReply, e: unknown): FastifyReply | undefined {
  if (e instanceof EngineError) {
    return reply.code(engineErrorStatus(e.code)).send({ error: e.code });
  }
  return undefined;
}

export function registerSocialRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine, bus } = deps;

  app.post('/api/rooms/:id/messages', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key!;
      if (room.ownerKeyId !== key.id && !storage.getMember(roomId, key.id)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    const body = z.object({ text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen) }).parse(req.body);
    try {
      const message = engine.humanPost(roomId, req.key!.id, req.key!.label ?? `user-${req.key!.id.slice(-4)}`, body.text);
      return await reply.code(201).send(message satisfies ChatMessage);
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped;
      throw e;
    }
  });

  app.post('/api/messages/:id/reactions', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const messageId = (req.params as { id: string }).id;
    const msg = storage.getMessage(messageId);
    if (!msg) return reply.code(404).send({ error: 'not_found' });
    if (msg.senderKind !== 'agent' || !msg.agentId) return reply.code(400).send({ error: 'not_agent_message' });
    if (msg.keyId === req.key!.id) return reply.code(403).send({ error: 'self_like' });
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    if (storage.countLikesByKeySince(req.key!.id, hourAgo) >= DEFAULT_LIMITS.reactionsPerKeyPerHour) {
      return reply.code(429).send({ error: 'too_many_reactions' });
    }
    const added = storage.addReaction(messageId, req.key!.id, new Date().toISOString());
    const likes = storage.countLikes(messageId);
    bus.emit(Topics.reaction, { roomId: msg.roomId, messageId, likes });
    return { likes, added };
  });

  app.get('/api/leaderboard', async () => {
    const entries = storage.topScores(10).map((s) => ({
      agentId: s.agentId,
      name: storage.getAgent(s.agentId)?.name ?? s.agentId,
      total: s.total,
      tier: s.tier,
      behavior: s.behavior,
      heat: s.heat,
      likes7d: s.likes7d,
    }));
    return { entries };
  });
}
```

`apps/server/src/app.ts`：buildApp 内追加 `registerSocialRoutes(app, deps);`，import 补 `import { registerSocialRoutes } from './http/routes-social.js';`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add message, reaction and leaderboard routes"
```

---

### Task 6: agent WS 网关 + composeServer

**Files:**
- Create: `apps/server/src/ws/agent-gateway.ts`
- Create: `apps/server/src/compose.ts`（buildApp + 双网关实例化与接线；本任务先只接 agent 网关，human 网关 Task 7 补）
- Test: `apps/server/test/ws-agent.test.ts`

**Interfaces:**
- Consumes: `AgentClientSchema/AgentServerSchema`、`Topics`、`RoomEngine`、`Storage`（Plan A 全部）
- Produces:
  - `class AgentGateway`：`constructor(deps)`、`handleUpgrade(req, socket, head)`、`forceDisconnect(agentId)`、`onlineCount(): number`
  - `composeServer(config, storage?) => { app, storage, engine, bus, agentGateway, humanGateway: null | HumanGateway }`——Task 6 返回 `humanGateway: null`，Task 7 改为实例；`composeServer` 内部 `ensureLobby`（幂等）
  - 连接语义：首帧必须 hello；key 无效/封禁 → close 4001；同 key agent 数超 `keyAgentsGlobal` → close 4002；lobby 存在且 active 时自动加入并回 `joined` 帧；`ready` 帧附 `limits:{deadlineMs, contextBytes}`；`join` 成功回 `joined`、失败回 `{type:'error', code}`；`post/skip` 回 `ack`；`ping` 回 `pong`；断开 → 离开所有房间 + offline；重复连接同 agentId → 旧连接被 4000 关闭

- [ ] **Step 1: 写失败测试**

`apps/server/test/ws-agent.test.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { testConfig } from './http-helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function start() {
  const handle = composeServer(testConfig());
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = handle.app.server.address();
  const url = `ws://127.0.0.1:${(addr as any).port}/ws/agent`;
  servers.push({ close: () => handle.app.close() });
  return { handle, url };
}

function connect(url: string): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }> }> {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  let resolveClosed: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => { resolveClosed = r; });
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  ws.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
  const ready = new Promise<void>((r) => ws.on('open', r));
  return ready.then(() => ({ ws, frames, closed }));
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

async function next(frames: any[], type: string): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const f = frames.find((x) => x.type === type && !seen.has(x));
    if (f) { seen.add(f); return f; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}
const seen = new WeakSet<object>();

describe('agent gateway', () => {
  it('无效 key 关闭 4001', async () => {
    const { url } = await start();
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: 'sk_bad', agent: { name: '小豆' } });
    expect((await c.closed).code).toBe(4001);
    c.ws.terminate();
  });

  it('hello → ready + joined(lobby)；ping → pong', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_a', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } });
    const ready = await next(c.frames, 'ready');
    expect(ready.agentId).toBeTruthy();
    expect(ready.limits.deadlineMs).toBe(20_000);
    expect(ready.limits.contextBytes).toBe(32_768);
    const joined = await next(c.frames, 'joined');
    expect(joined.roomId).toBe('lobby');
    expect(['active', 'waiting']).toContain(joined.status);
    send(c.ws, { type: 'ping', t: 1 });
    expect((await next(c.frames, 'pong')).t).toBe(1);
    expect(handle.storage.getAgent(ready.agentId)?.status).toBe('online');
    c.ws.terminate();
  });

  it('假 eventId post → ack rejected stale；join 未知房间 → error 帧', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_b', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '老豆' } });
    const ready = await next(c.frames, 'ready');
    send(c.ws, { type: 'post', eventId: 'ev_fake', text: '冒充' });
    const ack = await next(c.frames, 'ack');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('stale');
    send(c.ws, { type: 'join', roomId: 'rm_no' });
    const err = await next(c.frames, 'error');
    expect(err.code).toBe('not_found');
    c.ws.terminate();
  });

  it('human 投喂 → agent 收到 event；post → ack posted + 落库', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_c', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '三豆' } });
    await next(c.frames, 'joined');
    handle.engine.humanPost('lobby', 'key_x', '阿伟', '起个头');
    const event = await next(c.frames, 'event');
    expect(event.context.messages.at(-1).text).toBe('起个头');
    send(c.ws, { type: 'post', eventId: event.eventId, text: '我接一句' });
    const ack = await next(c.frames, 'ack');
    expect(ack.status).toBe('posted');
    expect(handle.storage.listMessages('lobby').at(-1)?.senderKind).toBe('agent');
    c.ws.terminate();
  });

  it('forceDisconnect 关闭 4003 且标记 offline', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_d', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '四豆' } });
    const ready = await next(c.frames, 'ready');
    handle.agentGateway.forceDisconnect(ready.agentId);
    expect((await c.closed).code).toBe(4003);
    await new Promise((r) => setTimeout(r, 20));
    expect(handle.storage.getAgent(ready.agentId)?.status).toBe('offline');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/ws-agent.test.ts`
Expected: FAIL（找不到 `../src/compose.js`）

- [ ] **Step 3: 实现**

`apps/server/src/ws/agent-gateway.ts` 全文：

```ts
import { DEFAULT_LIMITS, AgentClientSchema } from '@ai-smash/protocol';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { sha256 } from '../ids.js';
import { Topics } from '../topics.js';

function now(): string {
  return new Date().toISOString();
}

export class AgentGateway {
  private wss = new WebSocketServer({ noServer: true });
  private sockets = new Map<string, WebSocket>();

  constructor(private deps: AppDeps) {
    deps.bus.on(Topics.eventDispatch, (frame: any) => {
      const socket = this.sockets.get(frame.agentId);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    });
  }

  handleUpgrade(req: IncomingMessageLike, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req as any, socket, head, (ws) => this.onConnection(ws));
  }

  forceDisconnect(agentId: string): void {
    const ws = this.sockets.get(agentId);
    if (ws) this.close(ws, 4003, 'force_disconnected');
  }

  onlineCount(): number {
    return this.sockets.size;
  }

  private send(ws: WebSocket, frame: unknown): void {
    ws.send(JSON.stringify(frame));
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 已关闭则忽略
    }
  }

  private onConnection(ws: WebSocket): void {
    let agentId: string | null = null;
    // 规格 6.4：服务端 30s 协议级 ping，60s 无 pong 断开（用 WS 协议层 ping/pong，不占 JSON 帧）
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 60_000) return this.close(ws, 4000, 'heartbeat_timeout');
      ws.ping();
    }, 30_000);
    heartbeat.unref?.();
    ws.on('pong', () => { lastPong = Date.now(); });

    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = AgentClientSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // 非法帧静默丢弃
      }
      if (!agentId) {
        if (frame.type !== 'hello') return this.close(ws, 4001, 'hello_first');
        const key = this.deps.storage.getKeyByHash(sha256(frame.key));
        if (!key || key.status === 'banned') return this.close(ws, 4001, 'invalid_key');
        if (frame.agentId) {
          const existing = this.deps.storage.getAgent(frame.agentId);
          if (existing && existing.keyId !== key.id) return this.close(ws, 4001, 'invalid_agent');
        }
        let agent;
        try {
          agent = this.deps.storage.upsertAgent({
            ...(frame.agentId ? { id: frame.agentId } : {}),
            keyId: key.id, name: frame.agent.name, at: now(),
          });
        } catch {
          return this.close(ws, 4001, 'invalid_agent');
        }
        if (this.deps.storage.countAgentsByKey(key.id) > DEFAULT_LIMITS.keyAgentsGlobal) {
          return this.close(ws, 4002, 'agent_limit');
        }
        const old = this.sockets.get(agent.id);
        if (old) this.close(old, 4000, 'replaced');
        agentId = agent.id;
        this.sockets.set(agent.id, ws);
        this.deps.storage.setAgentStatus(agent.id, 'online', now());
        this.deps.storage.touchKey(key.id, now());
        const rooms: string[] = [];
        const lobby = this.deps.storage.getRoom('lobby');
        if (lobby && lobby.status === 'active') {
          const joined = this.deps.engine.joinRoom(agent.id, 'lobby');
          rooms.push('lobby');
          this.send(ws, { type: 'joined', roomId: 'lobby', status: joined.status });
        }
        this.send(ws, {
          type: 'ready',
          agentId: agent.id,
          rooms,
          limits: { deadlineMs: DEFAULT_LIMITS.deadlineMs, contextBytes: DEFAULT_LIMITS.contextBytes },
        });
        return;
      }
      const id = agentId;
      switch (frame.type) {
        case 'join': {
          try {
            const r = this.deps.engine.joinRoom(id, frame.roomId);
            this.send(ws, { type: 'joined', roomId: frame.roomId, status: r.status });
          } catch (e: any) {
            this.send(ws, { type: 'error', code: e.code ?? 'join_failed', message: String(e.message) });
          }
          return;
        }
        case 'leave': {
          this.deps.engine.leaveRoom(id, frame.roomId);
          return;
        }
        case 'typing': {
          return; // 预留：无行为
        }
        case 'post': {
          let replyTo = frame.replyTo;
          if (replyTo) {
            const target = this.deps.storage.getMessage(replyTo);
            const roomOfAgent = [...this.deps.storage.listRoomsOfAgent(id)].find((ra) => ra.status === 'active');
            if (!target || (roomOfAgent && target.roomId !== roomOfAgent.roomId)) replyTo = undefined;
          }
          const r = this.deps.engine.agentPost(id, frame.eventId, frame.text, replyTo);
          this.send(ws, { type: 'ack', eventId: frame.eventId, status: r.status, ...(r.status === 'rejected' ? { reason: (r as any).reason } : {}) });
          return;
        }
        case 'skip': {
          this.deps.engine.agentSkip(id, frame.eventId, frame.reason);
          this.send(ws, { type: 'ack', eventId: frame.eventId, status: 'skipped' });
          return;
        }
        case 'ping': {
          this.send(ws, { type: 'pong', t: frame.t });
          return;
        }
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (!agentId) return;
      this.sockets.delete(agentId);
      this.deps.storage.setAgentStatus(agentId, 'offline', now());
      for (const ra of this.deps.storage.listRoomsOfAgent(agentId)) {
        this.deps.engine.leaveRoom(agentId, ra.roomId);
      }
    });
  }
}

type IncomingMessageLike = Parameters<WebSocketServer['handleUpgrade']>[0];
```

（`IncomingMessageLike` 若 tsc 报错，直接 `import type { IncomingMessage } from 'node:http'` 并把签名改为 `req: IncomingMessage`。）

`apps/server/src/compose.ts` 全文（Task 6 版本，human 网关位置留 null，Task 7 填充）：

```ts
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { MemoryBus, RoomEngine, SqliteStorage } from './index.js';
import { AgentGateway } from './ws/agent-gateway.js';

export interface ServerHandle {
  app: ReturnType<typeof buildApp>;
  storage: SqliteStorage;
  engine: RoomEngine;
  bus: MemoryBus;
  agentGateway: AgentGateway;
  humanGateway: null;
  close(): Promise<void>;
}

export function composeServer(config: Config, provided?: SqliteStorage): ServerHandle {
  const storage = provided ?? new SqliteStorage(':memory:');
  storage.ensureLobby({ title: '公共大厅', maxAgents: 50, at: new Date().toISOString() });
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const app = buildApp({ storage, bus, engine, config });
  const agentGateway = new AgentGateway({ storage, bus, engine, config });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/agent') agentGateway.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return {
    app, storage, engine, bus, agentGateway, humanGateway: null,
    close: async () => {
      await app.close();
      storage.close();
    },
  };
}
```

注意：`ensureLobby` 的 maxAgents 用 `DEFAULT_LIMITS.lobbyMaxAgents`（50），此处直接写 50 与常量一致——**改成 `DEFAULT_LIMITS.lobbyMaxAgents`**（import 自 `@ai-smash/protocol`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（含 5 个 WS 用例）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add agent ws gateway and server composition"
```

---

### Task 7: 人类观测 WS 网关

**Files:**
- Create: `apps/server/src/ws/human-gateway.ts`
- Modify: `apps/server/src/compose.ts`（实例化 HumanGateway、upgrade 分发 `/ws/human`、`humanGateway` 不再为 null）
- Test: `apps/server/test/ws-human.test.ts`

**Interfaces:**
- Consumes: `HumanClientSchema/HumanServerSchema`、`roomSummary`、`toChatMessage`、`humanName`
- Produces: `class HumanGateway`：`handleUpgrade`、`broadcast(roomId, frame)`、`onlineCount(): number`
  - hello：房间不存在 → close 4004；私有房非成员（或无 key）→ close 4003；key 无效/封禁 → close 4001
  - ready：`{room, messages(最近50), agents(presence), you}`；匿名 `you: null`
  - 广播：`messageNew`→message、`presence`/`agentState`→presence、`roomUpdate`→room、`reaction`→reaction（按 roomId 路由）
  - post：需 key（匿名 → error 帧 `unauthorized`），经 `engine.humanPost`，EngineError → error 帧 code

- [ ] **Step 1: 写失败测试**

`apps/server/test/ws-human.test.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newInviteCode, newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { testConfig } from './http-helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function start() {
  const handle = composeServer(testConfig());
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (handle.app.server.address() as any).port;
  servers.push({ close: () => handle.app.close() });
  return { handle, agentUrl: `ws://127.0.0.1:${port}/ws/agent`, humanUrl: `ws://127.0.0.1:${port}/ws/human` };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  let resolveClosed: (v: { code: number }) => void;
  const closed = new Promise<{ code: number }>((r) => { resolveClosed = r; });
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  ws.on('close', (code) => resolveClosed({ code }));
  const ready = new Promise<void>((r) => ws.on('open', r));
  return ready.then(() => ({ ws, frames, closed }));
}

function send(ws: WebSocket, frame: unknown): void { ws.send(JSON.stringify(frame)); }

const seen = new WeakSet<object>();
async function next(frames: any[], type: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const f = [...frames].reverse().find((x) => x.type === type && !seen.has(x));
    if (f) { seen.add(f); return f; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}

async function connectAgent(handle: ReturnType<typeof composeServer>, url: string, name: string) {
  const raw = newKey();
  handle.storage.createKey({ id: `key_${name}`, hash: sha256(raw), label: null, createdAt: 't' });
  const c = await connect(url);
  send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name } });
  await next(c.frames, 'joined');
  return c;
}

describe('human gateway', () => {
  it('匿名看公开房：ready 带消息与 presence，you 为 null；发言被拒 unauthorized', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    await connectAgent(handle, agentUrl, '小豆');
    handle.engine.humanPost('lobby', 'key_x', '阿伟', '历史消息');
    const c = await connect(humanUrl);
    send(c.ws, { type: 'hello', roomId: 'lobby' });
    const ready = await next(c.frames, 'ready');
    expect(ready.room.id).toBe('lobby');
    expect(ready.messages.at(-1).text).toBe('历史消息');
    expect(ready.you).toBeNull();
    expect(ready.agents.some((a: any) => a.name === '小豆')).toBe(true);
    send(c.ws, { type: 'post', text: '匿名发言' });
    expect((await next(c.frames, 'error')).code).toBe('unauthorized');
    c.ws.terminate();
  });

  it('持 key 发言 → 双方收到 message 广播', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_h1', hash: sha256(raw), label: '阿伟', createdAt: 't' });
    await connectAgent(handle, agentUrl, '老豆');
    const human = await connect(humanUrl);
    send(human.ws, { type: 'hello', roomId: 'lobby', key: raw });
    await next(human.frames, 'ready');
    send(human.ws, { type: 'post', text: '人来了' });
    const msg = await next(human.frames, 'message');
    expect(msg.message.text).toBe('人来了');
    expect(msg.message.sender.name).toBe('阿伟');
    human.ws.terminate();
  });

  it('私有房：匿名 close 4003，成员可看', async () => {
    const { handle, humanUrl } = await start();
    const ownerRaw = newKey();
    handle.storage.createKey({ id: 'key_own', hash: sha256(ownerRaw), label: null, createdAt: 't' });
    const room = handle.storage.createRoom({
      id: 'rm_priv', title: '私密', topic: null, visibility: 'private',
      ownerKeyId: 'key_own', inviteCode: newInviteCode(), cooldownMs: 10_000, maxAgents: 20, at: 't',
    });
    const anon = await connect(humanUrl);
    send(anon.ws, { type: 'hello', roomId: 'rm_priv' });
    expect((await anon.closed).code).toBe(4003);
    const memberRaw = newKey();
    handle.storage.createKey({ id: 'key_mem', hash: sha256(memberRaw), label: null, createdAt: 't' });
    handle.storage.addMember('rm_priv', 'key_mem', 'member', 't');
    const member = await connect(humanUrl);
    send(member.ws, { type: 'hello', roomId: 'rm_priv', key: memberRaw });
    const ready = await next(member.frames, 'ready');
    expect(ready.room.id).toBe('rm_priv');
    expect(ready.you.isOwner).toBe(false);
    anon.ws.terminate();
    member.ws.terminate();
  });

  it('kick → presence 广播刷新', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const agentC = await connectAgent(handle, agentUrl, '五豆');
    const viewer = await connect(humanUrl);
    send(viewer.ws, { type: 'hello', roomId: 'lobby' });
    await next(viewer.frames, 'ready');
    const agentId = handle.storage.listAgents().find((a) => a.name === '五豆')!.id;
    handle.engine.kickAgent('lobby', agentId);
    const presence = await next(viewer.frames, 'presence');
    expect(presence.agents.some((a: any) => a.agentId === agentId)).toBe(false);
    agentC.ws.terminate();
    viewer.ws.terminate();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/ws-human.test.ts`
Expected: FAIL（`/ws/human` 升级被 `socket.destroy()`，连接失败）

- [ ] **Step 3: 实现**

`apps/server/src/ws/human-gateway.ts` 全文：

```ts
import { HumanClientSchema } from '@ai-smash/protocol';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { toChatMessage } from '../engine/chat.js';
import { sha256 } from '../ids.js';
import { Topics } from '../topics.js';
import { humanName } from '../http/auth.js';
import { roomSummary } from '../http/room-summary.js';

export class HumanGateway {
  private wss = new WebSocketServer({ noServer: true });
  private rooms = new Map<string, Set<WebSocket>>();

  constructor(private deps: AppDeps) {
    deps.bus.on(Topics.messageNew, (p: any) => {
      this.broadcast(p.message.roomId, { type: 'message', message: p.message });
    });
    deps.bus.on(Topics.presence, (p: any) => {
      this.broadcast(p.roomId, { type: 'presence', agents: this.deps.engine.listPresence(p.roomId) });
    });
    deps.bus.on(Topics.agentState, (p: any) => {
      this.broadcast(p.roomId, { type: 'presence', agents: this.deps.engine.listPresence(p.roomId) });
    });
    deps.bus.on(Topics.roomUpdate, (p: any) => {
      const room = this.deps.storage.getRoom(p.room.id);
      if (room) this.broadcast(room.id, { type: 'room', room: roomSummary(this.deps.storage, room) });
    });
    deps.bus.on(Topics.reaction, (p: any) => {
      this.broadcast(p.roomId, { type: 'reaction', messageId: p.messageId, likes: p.likes });
    });
  }

  handleUpgrade(req: any, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  onlineCount(): number {
    let n = 0;
    for (const set of this.rooms.values()) n += set.size;
    return n;
  }

  private broadcast(roomId: string, frame: unknown): void {
    for (const ws of this.rooms.get(roomId) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }
  }

  private send(ws: WebSocket, frame: unknown): void {
    ws.send(JSON.stringify(frame));
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 忽略
    }
  }

  private onConnection(ws: WebSocket): void {
    let joined: { roomId: string; keyId: string | null } | null = null;

    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = HumanClientSchema.parse(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!joined) {
        if (frame.type !== 'hello') return this.close(ws, 4000, 'hello_first');
        const room = this.deps.storage.getRoom(frame.roomId);
        if (!room) return this.close(ws, 4004, 'room_not_found');
        let keyId: string | null = null;
        let keyRow = null;
        if (frame.key) {
          keyRow = this.deps.storage.getKeyByHash(sha256(frame.key));
          if (!keyRow || keyRow.status === 'banned') return this.close(ws, 4001, 'invalid_key');
          keyId = keyRow.id;
        }
        if (room.visibility === 'private') {
          const allowed = keyId && this.deps.storage.getMember(room.id, keyId);
          if (!allowed) return this.close(ws, 4003, 'forbidden');
        }
        joined = { roomId: room.id, keyId };
        let set = this.rooms.get(room.id);
        if (!set) {
          set = new Set();
          this.rooms.set(room.id, set);
        }
        set.add(ws);
        this.send(ws, {
          type: 'ready',
          room: roomSummary(this.deps.storage, room),
          messages: this.deps.storage.listMessages(room.id, { limit: 50 }).map(toChatMessage),
          agents: this.deps.engine.listPresence(room.id),
          you: keyRow
            ? { keyId: keyRow.id, name: humanName(keyRow), isOwner: room.ownerKeyId === keyRow.id }
            : null,
        });
        return;
      }
      if (frame.type === 'ping') {
        this.send(ws, { type: 'pong', t: frame.t });
        return;
      }
      if (frame.type === 'post') {
        if (!joined.keyId) {
          this.send(ws, { type: 'error', code: 'unauthorized', message: '发言需要 key' });
          return;
        }
        const key = this.deps.storage.getKey(joined.keyId);
        if (!key || key.status === 'banned') return this.close(ws, 4001, 'invalid_key');
        const room = this.deps.storage.getRoom(joined.roomId);
        if (room?.visibility === 'private' && !this.deps.storage.getMember(room.id, key.id)) {
          this.send(ws, { type: 'error', code: 'forbidden', message: '不是房间成员' });
          return;
        }
        try {
          this.deps.engine.humanPost(joined.roomId, key.id, humanName(key), frame.text);
        } catch (e: any) {
          this.send(ws, { type: 'error', code: e.code ?? 'post_failed', message: String(e.message) });
        }
        return;
      }
    });

    ws.on('close', () => {
      if (!joined) return;
      const set = this.rooms.get(joined.roomId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.rooms.delete(joined.roomId);
      }
    });
  }
}
```

`apps/server/src/compose.ts` 修改为（ humanGateway 不再为 null）：

```ts
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { MemoryBus, RoomEngine, SqliteStorage } from './index.js';
import { AgentGateway } from './ws/agent-gateway.js';
import { HumanGateway } from './ws/human-gateway.js';

export interface ServerHandle {
  app: ReturnType<typeof buildApp>;
  storage: SqliteStorage;
  engine: RoomEngine;
  bus: MemoryBus;
  agentGateway: AgentGateway;
  humanGateway: HumanGateway;
  close(): Promise<void>;
}

export function composeServer(config: Config, provided?: SqliteStorage): ServerHandle {
  const storage = provided ?? new SqliteStorage(':memory:');
  storage.ensureLobby({ title: '公共大厅', maxAgents: DEFAULT_LIMITS.lobbyMaxAgents, at: new Date().toISOString() });
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const app = buildApp({ storage, bus, engine, config });
  const agentGateway = new AgentGateway({ storage, bus, engine, config });
  const humanGateway = new HumanGateway({ storage, bus, engine, config });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/agent') agentGateway.handleUpgrade(req, socket, head);
    else if (url.pathname === '/ws/human') humanGateway.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return {
    app, storage, engine, bus, agentGateway, humanGateway,
    close: async () => {
      await app.close();
      storage.close();
    },
  };
}
```

同时把 Task 6 的 `ws-agent.test.ts` 与本任务测试里所有 `humanGateway: null` 的引用清掉（测试只用 `handle.agentGateway`，无需改动）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add human ws gateway"
```

---

### Task 8: 管理端 REST + 存储增量（countMessagesSince / listEvents）

**Files:**
- Modify: `apps/server/src/storage/types.ts`（`Storage` 接口追加 `countMessagesSince(sinceIso): number` 与 `listEvents(opts): EventRow[]`）
- Modify: `apps/server/src/storage/sqlite.ts`（实现两方法）
- Create: `apps/server/src/http/routes-admin.ts`
- Modify: `apps/server/src/app.ts`（注册；`AppDeps` 追加 `agentGateway: AgentGateway | null`，compose 传入实例，纯 REST 测试传 null）
- Test: `apps/server/test/routes-admin.test.ts`

**Interfaces:**
- Produces（全部要求 `x-admin-token`，操作均写 `admin_audit`）:
  - `GET /api/admin/overview` → `{keys, agentsOnline, activeRooms, messages10m}`
  - `GET /api/admin/keys` / `POST /api/admin/keys/:id/ban`（封禁并强制断开该 key 全部 agent）`/unban`
  - `GET /api/admin/agents` / `POST /api/admin/agents/:id/disconnect`
  - `GET /api/admin/rooms` / `POST /api/admin/rooms/:id/pause|resume|archive` / `PATCH /api/admin/rooms/:id`（走 `engine.updateRoomSettings`）/ `POST /api/admin/rooms/:id/kick {agentId}`
  - `GET /api/admin/messages?roomId&limit` / `DELETE /api/admin/messages/:id`（软删）
  - `GET /api/admin/events?agentId&roomId&limit`
  - `GET /api/admin/audit?limit`

- [ ] **Step 1: 存储增量（先测后写）**

在 `apps/server/test/storage-admin.test.ts` 新建：

```ts
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('storage 增量（admin 支持）', () => {
  it('countMessagesSince 统计时间窗口内消息', () => {
    const s = new SqliteStorage(':memory:');
    const mk = (at: string) => s.insertMessage({
      roomId: 'lobby', senderKind: 'human', senderName: 'x',
      agentId: null, keyId: null, text: at, replyTo: null, createdAt: at,
    });
    mk('2026-10-26T00:00:00.000Z');
    mk('2026-10-26T00:05:00.000Z');
    mk('2026-10-25T00:00:00.000Z');
    expect(s.countMessagesSince('2026-10-25T12:00:00.000Z')).toBe(2);
  });
  it('listEvents 按 agent/room 过滤、倒序、limit', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r1', agentId: 'a1', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:01.000Z' });
    s.insertEvent({ id: 'ev_2', roomId: 'r2', agentId: 'a1', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:02.000Z' });
    s.insertEvent({ id: 'ev_3', roomId: 'r1', agentId: 'a2', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:03.000Z' });
    expect(s.listEvents({}).map((e) => e.id)).toEqual(['ev_3', 'ev_2', 'ev_1']);
    expect(s.listEvents({ agentId: 'a1' }).map((e) => e.id)).toEqual(['ev_2', 'ev_1']);
    expect(s.listEvents({ roomId: 'r1' }).map((e) => e.id)).toEqual(['ev_3', 'ev_1']);
    expect(s.listEvents({ limit: 1 }).map((e) => e.id)).toEqual(['ev_3']);
  });
});
```

实现：`types.ts` 的 `Storage` 接口 events 分组追加：

```ts
  listEvents(opts?: { roomId?: string; agentId?: string; limit?: number }): EventRow[]; // 新→旧
```

messages 分组追加：

```ts
  countMessagesSince(sinceIso: string): number;
```

`sqlite.ts` 追加实现：

```ts
  countMessagesSince(sinceIso: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?`).get(sinceIso) as any
    ).c;
  }

  listEvents(opts?: { roomId?: string; agentId?: string; limit?: number }): EventRow[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts?.roomId) { clauses.push('room_id = ?'); params.push(opts.roomId); }
    if (opts?.agentId) { clauses.push('agent_id = ?'); params.push(opts.agentId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 100);
    return (
      this.db.prepare(
        `SELECT * FROM events ${where} ORDER BY notified_at DESC LIMIT ?`,
      ).all(...params) as any[]
    ).map((r) => ({
      id: r.id, roomId: r.room_id, agentId: r.agent_id,
      triggerMessageId: r.trigger_message_id, status: r.status, reason: r.reason,
      notifiedAt: r.notified_at, decidedAt: r.decided_at, latencyMs: r.latency_ms,
    }));
  }
```

- [ ] **Step 2: 写管理路由失败测试**

`apps/server/test/routes-admin.test.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { admin, testConfig } from './http-helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function start() {
  const handle = composeServer(testConfig());
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (handle.app.server.address() as any).port;
  servers.push({ close: () => handle.app.close() });
  return { handle, port };
}

describe('admin routes', () => {
  it('无 token 401', async () => {
    const { handle } = await start();
    const res = await handle.app.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('overview 数字正确', async () => {
    const { handle } = await start();
    handle.storage.createKey({ id: 'key_1', hash: sha256(newKey()), label: null, createdAt: 't' });
    const res = await handle.app.inject({ method: 'GET', url: '/api/admin/overview', headers: admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toBe(1);
    expect(res.json().activeRooms).toBeGreaterThanOrEqual(1);
  });

  it('封 key 会强制断开其 agent 并记审计', async () => {
    const { handle, port } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_v', hash: sha256(raw), label: null, createdAt: 't' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } }));
    await new Promise((r) => setTimeout(r, 50));
    const agentId = handle.storage.listAgents()[0].id;
    const res = await handle.app.inject({ method: 'POST', url: '/api/admin/keys/key_v/ban', headers: admin() });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.agentGateway.onlineCount()).toBe(0);
    expect(handle.storage.getAgent(agentId)?.status).toBe('offline');
    const audit = handle.app.inject ? await handle.app.inject({ method: 'GET', url: '/api/admin/audit', headers: admin() }) : null;
    expect((audit as any).json().rows.some((r: any) => r.action === 'ban_key')).toBe(true);
    ws.terminate();
  });

  it('PATCH 房间走 updateRoomSettings：提高上限转正候补', async () => {
    const { handle } = await start();
    handle.storage.updateRoom('lobby', { maxAgents: 1 });
    handle.storage.upsertAgent({ id: 'ag_w', keyId: 'key_x', name: '候补', at: 't' });
    handle.storage.addRoomAgent('lobby', 'ag_w', 'waiting', 't1');
    const res = await handle.app.inject({ method: 'PATCH', url: '/api/admin/rooms/lobby', headers: admin(), payload: { maxAgents: 5 } });
    expect(res.statusCode).toBe(200);
    expect(handle.storage.getRoomAgent('lobby', 'ag_w')?.status).toBe('active');
  });

  it('大厅不可归档/删除（400 lobby_immutable）', async () => {
    const { handle } = await start();
    const archive = await handle.app.inject({ method: 'POST', url: '/api/admin/rooms/lobby/archive', headers: admin() });
    expect(archive.statusCode).toBe(400);
    expect(archive.json().error).toBe('lobby_immutable');
    const del = await handle.app.inject({ method: 'DELETE', url: '/api/admin/rooms/lobby', headers: admin() });
    expect(del.statusCode).toBe(400);
  });

  it('软删消息与事件查询', async () => {
    const { handle } = await start();
    const msg = handle.storage.insertMessage({
      roomId: 'lobby', senderKind: 'human', senderName: 'x',
      agentId: null, keyId: null, text: '违规', replyTo: null, createdAt: 't',
    });
    handle.storage.insertEvent({ id: 'ev_x', roomId: 'lobby', agentId: 'ag_x', triggerMessageId: msg.id, notifiedAt: 't' });
    const del = await handle.app.inject({ method: 'DELETE', url: `/api/admin/messages/${msg.id}`, headers: admin() });
    expect(del.statusCode).toBe(204);
    expect(handle.storage.getMessage(msg.id)?.deletedAt).toBeTruthy();
    const ev = await handle.app.inject({ method: 'GET', url: '/api/admin/events?agentId=ag_x', headers: admin() });
    expect(ev.json().rows.map((r: any) => r.id)).toEqual(['ev_x']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run apps/server/test/routes-admin.test.ts apps/server/test/storage-admin.test.ts`
Expected: FAIL（`countMessagesSince is not a function` / 404）

- [ ] **Step 4: 实现管理路由**

`apps/server/src/http/routes-admin.ts` 全文：

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from './auth.js';

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine, agentGateway } = deps;
  const guard = { preHandler: [requireAdmin(deps.config)] };

  const audit = (action: string, targetType: string, targetId: string, detail: unknown): void => {
    storage.insertAudit({
      action, targetType, targetId,
      detail: JSON.stringify(detail ?? {}),
      createdAt: new Date().toISOString(),
    });
  };

  app.get('/api/admin/overview', guard, async () => {
    const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
    return {
      keys: storage.listKeys().length,
      agentsOnline: storage.listAgents().filter((a) => a.status === 'online' || a.status === 'thinking').length,
      activeRooms: storage.listRooms().filter((r) => r.status === 'active').length,
      messages10m: storage.countMessagesSince(tenMinAgo),
      agentConnections: agentGateway?.onlineCount() ?? 0,
      humanConnections: deps.humanGateway?.onlineCount() ?? 0,
    };
  });

  app.get('/api/admin/keys', guard, async () => ({ rows: storage.listKeys() }));

  app.post('/api/admin/keys/:id/ban', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.setKeyStatus(id, 'banned');
    for (const agent of storage.listAgentsByKey(id)) {
      agentGateway?.forceDisconnect(agent.id);
    }
    audit('ban_key', 'key', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/keys/:id/unban', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.setKeyStatus(id, 'active');
    audit('unban_key', 'key', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/agents', guard, async () => ({
    rows: storage.listAgents().map((a) => ({ ...a, score: storage.getScore(a.id) ?? null })),
  }));

  app.post('/api/admin/agents/:id/disconnect', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    agentGateway?.forceDisconnect(id);
    audit('disconnect_agent', 'agent', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/rooms', guard, async () => ({ rows: storage.listRooms() }));

  app.post('/api/admin/rooms/:id/pause', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.pauseRoom(id);
    audit('pause_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/rooms/:id/resume', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.resumeRoom(id);
    audit('resume_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/rooms/:id/archive', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === 'lobby') return reply.code(400).send({ error: 'lobby_immutable' }); // 规格 5.3：大厅不可删除或归档
    storage.updateRoom(id, { status: 'archived' });
    audit('archive_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.delete('/api/admin/rooms/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === 'lobby') return reply.code(400).send({ error: 'lobby_immutable' });
    storage.updateRoom(id, { status: 'archived' }); // 规格 11：房间软删除 = 归档
    audit('delete_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.patch('/api/admin/rooms/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({
      title: z.string().min(1).max(64).optional(),
      topic: z.string().max(200).nullish(),
      cooldownMs: z.number().int().min(0).max(60_000).optional(),
      maxAgents: z.number().int().min(2).max(200).optional(),
    }).parse(req.body);
    const room = engine.updateRoomSettings(id, body);
    audit('update_room', 'room', id, body);
    return room;
  });

  app.post('/api/admin/rooms/:id/kick', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ agentId: z.string().min(1) }).parse(req.body);
    engine.kickAgent(id, body.agentId);
    audit('kick_agent', 'room_agent', `${id}:${body.agentId}`, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/messages', guard, async (req) => {
    const q = z.object({
      roomId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    const rows = q.roomId
      ? storage.listMessages(q.roomId, { limit: q.limit ?? 100 })
      : [];
    return { rows };
  });

  app.delete('/api/admin/messages/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.softDeleteMessage(id, new Date().toISOString());
    audit('delete_message', 'message', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/events', guard, async (req) => {
    const q = z.object({
      agentId: z.string().optional(),
      roomId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    return { rows: storage.listEvents(q) };
  });

  app.get('/api/admin/audit', guard, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { rows: storage.listAudit(q.limit ?? 100) };
  });
}
```

`apps/server/src/app.ts` 修改：
- `AppDeps` 增加两个可选字段：`agentGateway?: { forceDisconnect(id: string): void; onlineCount(): number } | null` 与 `humanGateway?: { onlineCount(): number } | null`
- buildApp 内追加 `registerAdminRoutes(app, deps);`，import 补 `import { registerAdminRoutes } from './http/routes-admin.js';`
- 注意 `AppDeps` 引用网关类型会造成 app.ts ↔ ws 目录循环 import——用上面的**结构类型**内联声明（不 import 类），compose.ts 传实例时结构兼容。

`apps/server/src/compose.ts`：`buildApp({ storage, bus, engine, config, agentGateway, humanGateway })`——但网关构造需要 deps……顺序问题：网关构造只用 storage/bus/engine/config，不引用 app。因此：先建 `base = { storage, bus, engine, config }`，再 `buildApp({ ...base, agentGateway: null, humanGateway: null })`？不行，admin 路由需要真网关。解法：先构造网关（它们的 deps 是 base），再 buildApp：

```ts
const base = { storage, bus, engine, config };
const agentGateway = new AgentGateway(base);
const humanGateway = new HumanGateway(base);
const app = buildApp({ ...base, agentGateway, humanGateway });
```

（Task 6 版本的 compose 里 `buildApp` 先于网关创建，本任务调整顺序；`agentGateway: null, humanGateway: null` 分支仅在测试里直接用 buildApp 时出现，类型可选即可。）

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add admin routes and storage additions"
```

---

### Task 9: 启动入口、评分定时器与静态托管

**Files:**
- Create: `apps/server/src/timer.ts`
- Create: `apps/server/src/server.ts`
- Modify: `apps/server/src/app.ts`（静态托管注册：存在 `apps/web/dist` 时挂 @fastify/static + SPA 回退）
- Modify: root `package.json`（scripts 增加 `"start": "node --experimental-transform-types apps/server/src/server.ts"`——仅作为文档性脚本，本计划不执行）
- Test: `apps/server/test/timer.test.ts`, `apps/server/test/boot.test.ts`

**Interfaces:**
- Produces:
  - `startScoringTimer(storage, limits, intervalMs=300_000) => {stop()}`：每 interval 调 `runScoring(storage, new Date(), limits)`，异常吞掉不中断
  - `main(): Promise<void>`（server.ts）：loadConfig → mkdir(dbPath 目录) → SqliteStorage → `markAllDeliveredAsTimeout`（重启恢复，日志输出恢复条数）→ composeServer → startScoringTimer → `app.listen({port, host:'0.0.0.0'})` → SIGINT/SIGTERM 优雅退出（stop timer → app.close → storage.close）
  - 静态托管：`apps/web/dist` 存在时 `GET /非/api` 路径回退 index.html（Plan D 产物）；不存在时不注册，/healthz 等不受影响

- [ ] **Step 1: 写失败测试**

`apps/server/test/timer.test.ts` 全文：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScoring } from '../src/engine/score.js';
import { startScoringTimer } from '../src/timer.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startScoringTimer', () => {
  it('按间隔触发 runScoring，stop 后不再触发', async () => {
    const storage = new SqliteStorage(':memory:');
    const spy = vi.spyOn({ runScoring }, 'runScoring');
    const t = startScoringTimer(storage, DEFAULT_LIMITS, 1000, spy.runScoring as any);
    await vi.advanceTimersByTimeAsync(2500);
    expect(spy.runScoring).toHaveBeenCalledTimes(2);
    t.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy.runScoring).toHaveBeenCalledTimes(2);
  });
});
```

`apps/server/test/boot.test.ts` 全文：

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { boot } from '../src/server.js';
import { testConfig } from './http-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const h of booted) await h.shutdown();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const booted: Array<{ shutdown: () => Promise<void> }> = [];

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'aismash-'));
  dirs.push(dir);
  const dbPath = join(dir, 'data', 'test.db');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const h = await boot({ ...testConfig(), dbPath, port: 0 });
  booted.push(h);
  const port = (h.app.server.address() as any).port;
  return { h, base: `http://127.0.0.1:${port}` };
}

describe('boot（server.ts 组装）', () => {
  it('启动即有大厅；重启恢复把未决事件记 timeout', async () => {
    const first = await start();
    const raw = newKey();
    first.h.storage.createKey({ id: 'key_r', hash: sha256(raw), label: null, createdAt: 't' });
    first.h.storage.upsertAgent({ id: 'ag_r', keyId: 'key_r', name: '小豆', at: 't' });
    first.h.storage.insertEvent({ id: 'ev_pending', roomId: 'lobby', agentId: 'ag_r', triggerMessageId: 'm', notifiedAt: 't' });
    await first.h.shutdown();

    const second = await boot({ ...testConfig(), dbPath: join(dirs[0], 'data', 'test.db'), port: 0 });
    booted.push(second);
    expect(second.storage.getRoom('lobby')).toBeTruthy();
    expect(second.storage.getEvent('ev_pending')?.status).toBe('timeout');
  });

  it('存在 apps/web/dist 时 SPA 回退，API 路径不回退', async () => {
    // 用临时 dist 验证：boot 前在 cwd 相对路径造一个假 dist
    const distDir = 'apps/web/dist';
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html>spa</html>');
    try {
      const { h, base } = await start();
      const res = await fetch(`${base}/some/spa/route`);
      expect(await res.text()).toContain('spa');
      const api = await fetch(`${base}/api/nothing`);
      expect(api.status).toBe(404);
      await h.shutdown();
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/timer.test.ts apps/server/test/boot.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

`apps/server/src/timer.ts` 全文：

```ts
import type { Limits } from '@ai-smash/protocol';
import { runScoring } from './engine/score.js';
import type { Storage } from './storage/types.js';

export type ScoringFn = (storage: Storage, now: Date, limits: Limits) => number;

export function startScoringTimer(
  storage: Storage,
  limits: Limits,
  intervalMs = 300_000,
  fn: ScoringFn = runScoring,
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      fn(storage, new Date(), limits);
    } catch {
      // 评分失败不影响主流程
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

`apps/server/src/server.ts` 全文：

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { loadConfig, type Config } from './config.js';
import { composeServer } from './compose.js';
import { SqliteStorage } from './storage/sqlite.js';
import { startScoringTimer } from './timer.js';

export interface BootHandle {
  app: ReturnType<typeof composeServer>['app'];
  storage: SqliteStorage;
  shutdown(): Promise<void>;
}

export async function boot(over?: Partial<Config>): Promise<BootHandle> {
  const config = { ...loadConfig(), ...over };
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const storage = new SqliteStorage(config.dbPath);
  const recovered = storage.markAllDeliveredAsTimeout(new Date().toISOString());
  if (recovered > 0) console.log(`[boot] recovered ${recovered} pending event(s) as timeout`);
  const handle = composeServer(config, storage);
  const scoring = startScoringTimer(storage, DEFAULT_LIMITS);
  await handle.app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[boot] AI-Smash server listening on :${config.port}`);
  return {
    app: handle.app,
    storage,
    shutdown: async () => {
      scoring.stop();
      await handle.app.close();
      storage.close();
    },
  };
}

export async function main(): Promise<void> {
  const handle = await boot();
  const exit = () => {
    void handle.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}

// 直接运行时启动；被测试导入时静默
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```

`apps/server/src/app.ts` 的 `buildApp` 里、admin 路由注册之后追加静态托管：

```ts
  registerStatic(app);
```

文件内新增（app.ts 底部）：

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';

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
```

（`readFileSync` 从 `node:fs` 一并 import。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add boot entry, scoring timer and static hosting"
```

---

### Task 10: 服务端 E2E 冒烟

**Files:**
- Test: `apps/server/test/e2e-smoke.test.ts`

**Interfaces:**
- Consumes: 前面全部产物（REST + 双 WS + boot）
- Produces: 一条完整的「申请 key → agent 接入 → 人投喂 → agent 回复 → 人点赞 → 评分 → 管理员封禁」链路断言

- [ ] **Step 1: 写测试**

`apps/server/test/e2e-smoke.test.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { runScoring } from '../src/engine/score.js';
import { boot } from '../src/server.js';
import { admin, testConfig } from './http-helpers.js';

const booted: Array<{ shutdown: () => Promise<void> }> = [];
afterAll(async () => { for (const h of booted) await h.shutdown(); });

async function start() {
  const h = await boot({ ...testConfig(), port: 0 });
  booted.push(h);
  const port = (h.app.server.address() as any).port;
  return { h, base: `http://127.0.0.1:${port}`, agentUrl: `ws://127.0.0.1:${port}/ws/agent`, humanUrl: `ws://127.0.0.1:${port}/ws/human` };
}

const seen = new WeakSet<object>();
async function next(frames: any[], type: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const f = [...frames].reverse().find((x) => x.type === type && !seen.has(x));
    if (f) { seen.add(f); return f; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}

describe('E2E 冒烟：key → agent → 投喂 → 回复 → 点赞 → 评分 → 封禁', () => {
  it('全链路', async () => {
    const { h, base, agentUrl } = await start();

    // 1. 申请 key
    const keyRes = await fetch(`${base}/api/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '玩家一' }),
    });
    expect(keyRes.status).toBe(201);
    const { key: raw, id: keyId } = await keyRes.json() as any;

    // 2. agent 接入并自动进入大厅
    const ws = new WebSocket(agentUrl);
    const frames: any[] = [];
    let closedCode = 0;
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    ws.on('close', (c) => { closedCode = c; });
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '冲榜手' } }));
    const joined = await next(frames, 'joined');
    expect(joined.roomId).toBe('lobby');

    // 3. 人投喂
    const postRes = await fetch(`${base}/api/rooms/lobby/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
      body: JSON.stringify({ text: '谁来聊聊评分系统' }),
    });
    expect(postRes.status).toBe(201);

    // 4. agent 收到 event 并回复
    const event = await next(frames, 'event');
    expect(event.trigger.sender.kind).toBe('human');
    ws.send(JSON.stringify({ type: 'post', eventId: event.eventId, text: '我来聊聊：分数 = 行为 0.7 + 热度 0.3' }));
    const ack = await next(frames, 'ack');
    expect(ack.status).toBe('posted');

    // 5. 观众点赞 agent 的回复（用另一把 key）
    const likeKeyRes = await fetch(`${base}/api/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const likeKey = await likeKeyRes.json() as any;
    const agentMsg = h.storage.listMessages('lobby').find((m) => m.senderKind === 'agent')!;
    const likeRes = await fetch(`${base}/api/messages/${agentMsg.id}/reactions`, {
      method: 'POST', headers: { authorization: `Bearer ${likeKey.key}` },
    });
    expect(likeRes.status).toBe(200);
    expect((await likeRes.json() as any).likes).toBe(1);

    // 6. 评分落库
    expect(runScoring(h.storage, new Date(), DEFAULT_LIMITS)).toBeGreaterThanOrEqual(1);
    const score = h.storage.getScore(h.storage.listAgents().find((a) => a.name === '冲榜手')!.id);
    expect(score?.likes7d).toBe(1);

    // 7. 管理员封禁 → agent 断开 4003
    const ban = await fetch(`${base}/api/admin/keys/${keyId}/ban`, { method: 'POST', headers: admin() });
    expect(ban.status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(closedCode).toBe(4003);

    // 8. 被封 key 的 REST 访问 403
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${raw}` } });
    expect(me.status).toBe(403);

    ws.terminate();
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `npx vitest run apps/server/test/e2e-smoke.test.ts`
Expected: 1 个用例 PASS。若第 4 步收不到 event，检查 agent 是否真的 joined（hello 后 joined 帧顺序）。

- [ ] **Step 3: 全量回归**

Run: `npx vitest run && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（协议 8 + 服务端全部，只许多）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(server): add end-to-end smoke covering key agent human score ban"
```

---

## 验收清单（Plan B 完成标准）

1. `npx vitest run` 全绿；两包 `tsc --noEmit` 干净；全程未占用固定端口、未构建。
2. REST：keys（限频/撤销）、me、rooms（创建/列表/详情/邀请码加入/历史）、发言、点赞（防自刷/限频/幂等/广播）、leaderboard、admin 全套（封禁即断线、审计落库）。
3. WS：agent 网关（hello/ready/joined/event/post/skip/ack/ping、断开清理、顶号、forceDisconnect）；human 网关（匿名只读、私有房成员制、发言鉴权、message/presence/room/reaction 广播）。
4. 启动：ensureLobby、重启恢复（未决→timeout）、评分定时器、静态托管（dist 存在时 SPA 回退）、优雅退出。
5. E2E 冒烟覆盖规格核心链路。

## 后续计划（另行编写）

- **Plan C**：`ai-smash-bridge` CLI（stdio JSON Lines、超时代答 skip、崩溃退避重启、重连、`demo` 回声 agent）。
- **Plan D**：Web 前端（官网 / 直播间 / 我的 / 管理端），产物输出到 `apps/web/dist` 被本计划静态托管。
- **Plan E**：Playwright E2E + 50 假 agent 压测冒烟。







