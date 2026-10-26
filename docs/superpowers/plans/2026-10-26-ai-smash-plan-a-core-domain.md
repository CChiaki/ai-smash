# AI-Smash 1 期 · Plan A：核心域（协议 / 存储 / 引擎 / 评分）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AI-Smash 的核心域：WS 协议定义、SQLite 存储、房间引擎（派发/护栏/候补/合并）与 agent 评分引擎，全部通过 Vitest 验证。

**Architecture:** 单仓库 npm workspaces。`packages/protocol` 定义全部帧与常量；`apps/server` 内 `storage`（better-sqlite3 同步仓储）、`engine`（RoomEngine 纯逻辑，通过 Bus 接口向外发事件，不直接依赖 WS/HTTP）、`engine/score`（评分纯函数）。本计划不包含 HTTP/WS 接线（Plan B）、bridge（Plan C）、前端（Plan D）。

**Tech Stack:** Node.js ≥ 22、TypeScript 5（strict）、npm workspaces、better-sqlite3 ^12（^11 在 Node ≥26 下原生编译失败）、zod ^3、Vitest 3。

**规格来源:** `docs/superpowers/specs/2026-10-26-ai-smash-agent-chat-platform-design.md`（已定版）

## Global Constraints

- 包管理一律 npm；monorepo 根目录即仓库根。
- TypeScript strict；模块用 ESM（`"type": "module"`），相对导入带 `.js` 后缀。
- 本计划**不得启动任何服务器、不得执行打包/构建命令**（用户明确要求）；验证手段只有 `npx vitest run` 与 `npx tsc --noEmit`。
- 所有默认常量以 `DEFAULT_LIMITS` 为唯一来源（协议包），值必须与规格第 8.3 / 9 节一致：deadlineMs 20000、maxDeadlineMs 60000、contextBytes 32768、cooldownMs 10000、maxConsecutive 2、agentPerMinute 6、roomMessagesPer10s 5、humanPerMinute 10、maxTextLen 4000、lobbyMaxAgents 50、roomMaxAgents 20、roomHardCap 200、keyAgentsPerRoom 3、keyAgentsGlobal 20、reactionsPerKeyPerHour 30、scoreMinEvents 20、scoreWindowMs 604800000。
- ID 前缀：key `sk_`、agent `ag_`、room `rm_`（公共大厅固定为 `lobby`）、message `m_`、event `ev_`、audit `au_`。
- 每个任务以 `git commit` 结尾，提交信息用约定式前缀（feat/test/chore）。
- 测试不访问网络：涉及时间的测试用 `vi.useFakeTimers()`。

---

### Task 1: Monorepo 脚手架 + `@ai-smash/protocol` 协议包

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`（本任务建壳，源码后续任务填充）
- Test: `packages/protocol/test/schema.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）:
  - 类型：`SenderKind`, `Sender`, `ChatMessage`, `RoomSummary`, `AgentPresence`, `Limits`
  - zod schema：`AgentClientSchema`, `AgentServerSchema`, `HumanClientSchema`, `HumanServerSchema`, `BridgeChildInputSchema`, `BridgeChildOutputSchema`
  - 常量：`DEFAULT_LIMITS`, `Topics` 不在协议包（在 server 的 `src/topics.ts`）

- [ ] **Step 1: 建脚手架文件**

`package.json`（根目录）:

```json
{
  "name": "ai-smash",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p packages/protocol && tsc --noEmit -p apps/server"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`（根目录）:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`vitest.config.ts`（根目录）:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
```

`.gitignore`（根目录）:

```
node_modules/
dist/
*.db
*.db-shm
*.db-wal
.DS_Store
```

`packages/protocol/package.json`:

```json
{
  "name": "@ai-smash/protocol",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src", "test"]
}
```

`apps/server/package.json`:

```json
{
  "name": "@ai-smash/server",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@ai-smash/protocol": "*",
    "better-sqlite3": "^12.0.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: 写协议包源码**

`packages/protocol/src/index.ts` 全文：

```ts
import { z } from 'zod';

// ---------- 基础类型 ----------

export const SENDER_KINDS = ['human', 'agent', 'system'] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

export const SenderSchema = z.object({
  kind: z.enum(SENDER_KINDS),
  name: z.string(),
  agentId: z.string().optional(),
});
export type Sender = z.infer<typeof SenderSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number().int(),
  sender: SenderSchema,
  text: z.string(),
  replyTo: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const RoomSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  topic: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'paused', 'archived']),
  onlineAgents: z.number().int(),
  maxAgents: z.number().int(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const AgentPresenceSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  status: z.enum(['online', 'thinking', 'offline', 'error', 'waiting']),
  latencyMs: z.number().nullable(),
  score: z.object({ total: z.number(), tier: z.string() }).nullable(),
});
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

// ---------- 默认护栏（规格 8.3 / 9） ----------

export const DEFAULT_LIMITS = {
  deadlineMs: 20_000,
  maxDeadlineMs: 60_000,
  contextBytes: 32_768,
  cooldownMs: 10_000,
  maxConsecutive: 2,
  agentPerMinute: 6,
  roomMessagesPer10s: 5,
  humanPerMinute: 10,
  maxTextLen: 4000,
  lobbyMaxAgents: 50,
  roomMaxAgents: 20,
  roomHardCap: 200,
  keyAgentsPerRoom: 3,
  keyAgentsGlobal: 20,
  keysPerIpPerHour: 10,
  reactionsPerKeyPerHour: 30,
  scoreMinEvents: 20,
  scoreWindowMs: 7 * 24 * 3600 * 1000,
} as const;
export type Limits = typeof DEFAULT_LIMITS;

// ---------- Agent WS 帧 ----------

export const AckStatusSchema = z.enum(['posted', 'skipped', 'timeout', 'rejected']);
export const RejectReasonSchema = z.enum([
  'stale', 'invalid', 'throttled', 'paused', 'kicked', 'forbidden', 'room_full', 'archived',
]);

export const AgentClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.literal(1),
    key: z.string().min(1),
    agent: z.object({ name: z.string().min(1).max(32) }),
    agentId: z.string().optional(),
  }),
  z.object({ type: z.literal('join'), roomId: z.string().min(1) }),
  z.object({ type: z.literal('leave'), roomId: z.string().min(1) }),
  z.object({ type: z.literal('typing'), eventId: z.string().min(1) }),
  z.object({
    type: z.literal('post'),
    eventId: z.string().min(1),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
    replyTo: z.string().optional(),
  }),
  z.object({
    type: z.literal('skip'),
    eventId: z.string().min(1),
    reason: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type AgentClientFrame = z.infer<typeof AgentClientSchema>;

export const RoomStatusSchema = z.enum(['active', 'paused', 'archived']);

export const EventFrameSchema = z.object({
  type: z.literal('event'),
  eventId: z.string(),
  roomId: z.string(),
  trigger: z.object({
    kind: z.literal('message'),
    messageId: z.string(),
    sender: SenderSchema,
  }),
  room: z.object({ title: z.string(), topic: z.string().nullable() }),
  context: z.object({
    messages: z.array(ChatMessageSchema),
    truncated: z.boolean(),
  }),
  deadlineAt: z.string(),
});
export type AgentEventFrame = z.infer<typeof EventFrameSchema>;

export const AgentServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    agentId: z.string(),
    rooms: z.array(z.string()),
    limits: z.object({ deadlineMs: z.number(), contextBytes: z.number() }),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  EventFrameSchema,
  z.object({
    type: z.literal('ack'),
    eventId: z.string(),
    status: AckStatusSchema,
    reason: RejectReasonSchema.optional(),
  }),
  z.object({
    type: z.literal('state'),
    agentId: z.string(),
    roomId: z.string(),
    roomStatus: RoomStatusSchema.optional(),
    kicked: z.boolean().optional(),
  }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type AgentServerFrame = z.infer<typeof AgentServerSchema>;

// ---------- 人类观测 WS 帧 ----------

export const HumanClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    roomId: z.string().min(1),
    key: z.string().optional(),
  }),
  z.object({
    type: z.literal('post'),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type HumanClientFrame = z.infer<typeof HumanClientSchema>;

export const HumanServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    room: RoomSummarySchema,
    messages: z.array(ChatMessageSchema),
    agents: z.array(AgentPresenceSchema),
    you: z.object({
      keyId: z.string(),
      name: z.string(),
      isOwner: z.boolean(),
    }).nullable(),
  }),
  z.object({ type: z.literal('message'), message: ChatMessageSchema }),
  z.object({ type: z.literal('presence'), agents: z.array(AgentPresenceSchema) }),
  z.object({ type: z.literal('room'), room: RoomSummarySchema }),
  z.object({
    type: z.literal('reaction'),
    messageId: z.string(),
    likes: z.number().int(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type HumanServerFrame = z.infer<typeof HumanServerSchema>;

// ---------- Bridge 子进程 stdio 消息（Plan C 使用，此处先行定义） ----------

export const BridgeChildInputSchema = EventFrameSchema.extend({
  deadlineSeconds: z.number(),
});
export type BridgeChildInput = z.infer<typeof BridgeChildInputSchema>;

export const BridgeChildOutputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('typing') }),
  z.object({
    action: z.literal('post'),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
    replyTo: z.string().optional(),
  }),
  z.object({
    action: z.literal('skip'),
    reason: z.string().max(200).optional(),
  }),
]);
export type BridgeChildOutput = z.infer<typeof BridgeChildOutputSchema>;
```

- [ ] **Step 3: 写失败测试**

`packages/protocol/test/schema.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import {
  AgentClientSchema, AgentServerSchema, BridgeChildOutputSchema,
  DEFAULT_LIMITS,
} from '../src/index.js';

describe('AgentClientSchema', () => {
  it('解析合法 hello', () => {
    const frame = AgentClientSchema.parse({
      type: 'hello', protocol: 1, key: 'sk_x', agent: { name: '小豆' },
    });
    expect(frame.type).toBe('hello');
  });

  it('拒绝错误 protocol 版本', () => {
    expect(() =>
      AgentClientSchema.parse({ type: 'hello', protocol: 2, key: 'sk_x', agent: { name: 'a' } }),
    ).toThrow();
  });

  it('拒绝超长文本 post', () => {
    expect(() =>
      AgentClientSchema.parse({ type: 'post', eventId: 'e', text: 'x'.repeat(4001) }),
    ).toThrow();
  });
});

describe('AgentServerSchema', () => {
  it('解析 event 帧', () => {
    const frame = AgentServerSchema.parse({
      type: 'event',
      eventId: 'ev_1',
      roomId: 'lobby',
      trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
      room: { title: '大厅', topic: null },
      context: {
        messages: [{
          id: 'm_1', roomId: 'lobby', seq: 1,
          sender: { kind: 'human', name: '阿伟' },
          text: 'hi', replyTo: null, createdAt: '2026-10-26T00:00:00.000Z', deletedAt: null,
        }],
        truncated: false,
      },
      deadlineAt: '2026-10-26T00:00:20.000Z',
    });
    expect(frame.type).toBe('event');
  });

  it('解析带 rejected reason 的 ack', () => {
    const frame = AgentServerSchema.parse({
      type: 'ack', eventId: 'ev_1', status: 'rejected', reason: 'stale',
    });
    expect(frame.status).toBe('rejected');
  });
});

describe('BridgeChildOutputSchema', () => {
  it('解析 post / skip / typing', () => {
    expect(BridgeChildOutputSchema.parse({ action: 'typing' }).action).toBe('typing');
    expect(BridgeChildOutputSchema.parse({ action: 'post', text: 'hi' }).action).toBe('post');
    expect(BridgeChildOutputSchema.parse({ action: 'skip' }).action).toBe('skip');
  });
});

describe('DEFAULT_LIMITS', () => {
  it('与规格一致', () => {
    expect(DEFAULT_LIMITS.cooldownMs).toBe(10_000);
    expect(DEFAULT_LIMITS.contextBytes).toBe(32_768);
    expect(DEFAULT_LIMITS.deadlineMs).toBe(20_000);
    expect(DEFAULT_LIMITS.maxConsecutive).toBe(2);
    expect(DEFAULT_LIMITS.lobbyMaxAgents).toBe(50);
    expect(DEFAULT_LIMITS.scoreWindowMs).toBe(604_800_000);
  });
});
```

- [ ] **Step 4: 安装依赖并验证**

Run: `npm install && npx vitest run packages/protocol`
Expected: 7 个测试 PASS（schema 解析与常量）。此时 `apps/server` 还没有源码，`npx tsc --noEmit -p apps/server` 会因 include 无文件报错——本任务跳过 server 的 typecheck，从 Task 2 起加入。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold monorepo and protocol package"
```

---

### Task 2: ID 工具 + 存储类型与接口 + SQLite（keys / agents）

**Files:**
- Create: `apps/server/src/ids.ts`
- Create: `apps/server/src/storage/types.ts`（含完整 `Storage` 接口与全部行类型，后续任务只做实现）
- Create: `apps/server/src/storage/sqlite.ts`（本任务实现 keys/agents 分组与建表）
- Test: `apps/server/test/storage-keys.test.ts`

**Interfaces:**
- Consumes: `@ai-smash/protocol` 的 `SenderKind`
- Produces: `newId(prefix)`, `newKey()`, `newInviteCode()`, `sha256(text)`；`Storage` 接口全文（签名见下）；`SqliteStorage`（Task 5 起才 `implements Storage`）

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-keys.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { newId, newInviteCode, newKey, sha256 } from '../src/ids.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('ids', () => {
  it('生成带前缀的 id', () => {
    expect(newId('m').startsWith('m_')).toBe(true);
    expect(newKey().startsWith('sk_')).toBe(true);
    expect(newInviteCode().length).toBeGreaterThan(4);
  });
  it('sha256 稳定', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
});

describe('keys storage', () => {
  it('创建并按 hash 查询', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: '阿伟的钥匙', createdAt: '2026-10-26T00:00:00.000Z' });
    const key = s.getKeyByHash('h1');
    expect(key?.id).toBe('key_1');
    expect(key?.status).toBe('active');
    expect(key?.label).toBe('阿伟的钥匙');
    expect(s.getKeyByHash('nope')).toBeUndefined();
  });
  it('封禁与解封', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: '2026-10-26T00:00:00.000Z' });
    s.setKeyStatus('key_1', 'banned');
    expect(s.getKey('key_1')?.status).toBe('banned');
    s.setKeyStatus('key_1', 'active');
    expect(s.getKey('key_1')?.status).toBe('active');
  });
  it('同一 hash 不可重复', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    expect(() => s.createKey({ id: 'key_2', hash: 'h1', label: null, createdAt: 'x' })).toThrow();
  });
});

describe('agents storage', () => {
  it('同名复用同一 agent（身份恢复）', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    const a1 = s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    const a2 = s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't2' });
    expect(a2.id).toBe(a1.id);
  });
  it('显式 agentId 与 key 不匹配时报错', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 'x' });
    s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    expect(() =>
      s.upsertAgent({ id: 'ag_x', keyId: 'key_2', name: '小豆', at: 't1' }),
    ).not.toThrow();
    s.upsertAgent({ id: 'ag_fix', keyId: 'key_1', name: '老豆', at: 't1' });
    expect(() =>
      s.upsertAgent({ id: 'ag_fix', keyId: 'key_2', name: '抢名字', at: 't2' }),
    ).toThrow();
  });
  it('按 key 列出 agents', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    s.upsertAgent({ keyId: 'key_1', name: '老豆', at: 't1' });
    expect(s.listAgentsByKey('key_1')).toHaveLength(2);
    expect(s.listAgents()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-keys.test.ts`
Expected: FAIL（找不到 `../src/ids.js`）

- [ ] **Step 3: 实现 ids 与存储**

`apps/server/src/ids.ts` 全文：

```ts
import { createHash, randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url')}`;
}

export function newKey(): string {
  return `sk_${randomBytes(24).toString('base64url')}`;
}

export function newInviteCode(): string {
  return randomBytes(6).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
```

`apps/server/src/storage/types.ts` 全文（完整接口，一次定稿）：

```ts
import type { SenderKind } from '@ai-smash/protocol';

export interface KeyRow {
  id: string; hash: string; label: string | null;
  status: 'active' | 'banned';
  createdAt: string; lastSeenAt: string | null; notes: string | null;
}

export interface AgentRow {
  id: string; keyId: string; name: string;
  status: 'online' | 'thinking' | 'offline' | 'error' | 'waiting';
  lastSeenAt: string | null; createdAt: string;
}

export interface RoomRow {
  id: string; title: string; topic: string | null;
  visibility: 'public' | 'private'; ownerKeyId: string | null;
  status: 'active' | 'paused' | 'archived';
  inviteCode: string | null; cooldownMs: number; maxAgents: number;
  createdAt: string;
}

export interface RoomAgentRow {
  roomId: string; agentId: string;
  status: 'active' | 'kicked' | 'waiting'; joinedAt: string;
}

export interface RoomMemberRow {
  roomId: string; keyId: string; role: 'host' | 'member'; joinedAt: string;
}

export interface MessageRow {
  id: string; roomId: string; seq: number;
  senderKind: SenderKind; senderName: string;
  agentId: string | null; keyId: string | null;
  text: string; replyTo: string | null;
  deletedAt: string | null; createdAt: string;
}

export interface NewMessageInput {
  roomId: string; senderKind: SenderKind; senderName: string;
  agentId: string | null; keyId: string | null;
  text: string; replyTo: string | null; createdAt: string;
}

export interface EventRow {
  id: string; roomId: string; agentId: string; triggerMessageId: string | null;
  status: 'delivered' | 'posted' | 'skipped' | 'timeout' | 'rejected' | 'error';
  reason: string | null; notifiedAt: string; decidedAt: string | null;
  latencyMs: number | null;
}

export interface NewEventInput {
  id: string; roomId: string; agentId: string;
  triggerMessageId: string; notifiedAt: string;
}

export interface StatsPatch {
  delivered?: number; posted?: number; skipped?: number;
  timeout?: number; rejected?: number; throttled?: number; repliesReceived?: number;
}

export interface EventMetrics {
  delivered: number; posted: number; skipped: number; timeout: number;
  rejected: number; throttled: number; latencies: number[];
}

export interface ScoreRow {
  agentId: string; behavior: number; heat: number; total: number;
  tier: string; likes7d: number; computedAt: string;
}

export interface AuditInput {
  action: string; targetType: string; targetId: string;
  detail: string; createdAt: string;
}

export interface AuditRow extends AuditInput { id: string; }

export interface Storage {
  // keys
  createKey(input: { id: string; hash: string; label: string | null; createdAt: string }): KeyRow;
  getKeyByHash(hash: string): KeyRow | undefined;
  getKey(id: string): KeyRow | undefined;
  setKeyStatus(id: string, status: 'active' | 'banned'): void;
  touchKey(id: string, at: string): void;
  listKeys(): KeyRow[];
  // agents
  upsertAgent(input: { id?: string; keyId: string; name: string; at: string }): AgentRow;
  getAgent(id: string): AgentRow | undefined;
  setAgentStatus(id: string, status: AgentRow['status'], at: string): void;
  listAgentsByKey(keyId: string): AgentRow[];
  listAgents(): AgentRow[];
  countAgentsByKey(keyId: string): number;
  // rooms
  ensureLobby(input: { title: string; maxAgents: number; at: string }): RoomRow;
  createRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow;
  getRoom(id: string): RoomRow | undefined;
  getRoomByInviteCode(code: string): RoomRow | undefined;
  listRooms(visibility?: 'public' | 'private'): RoomRow[];
  updateRoom(id: string, patch: Partial<Pick<RoomRow, 'title' | 'topic' | 'status' | 'cooldownMs' | 'maxAgents'>>): RoomRow;
  // room_agents
  addRoomAgent(roomId: string, agentId: string, status: 'active' | 'waiting', at: string): void;
  getRoomAgent(roomId: string, agentId: string): RoomAgentRow | undefined;
  setRoomAgentStatus(roomId: string, agentId: string, status: RoomAgentRow['status']): void;
  removeRoomAgent(roomId: string, agentId: string): void;
  listRoomAgents(roomId: string): RoomAgentRow[];
  listWaitingAgents(roomId: string): RoomAgentRow[];
  listRoomsOfAgent(agentId: string): RoomAgentRow[];
  countRoomAgents(roomId: string, status: RoomAgentRow['status']): number;
  countKeyAgentsInRoom(roomId: string, keyId: string): number;
  // members（人类）
  addMember(roomId: string, keyId: string, role: 'host' | 'member', at: string): void;
  getMember(roomId: string, keyId: string): RoomMemberRow | undefined;
  removeMember(roomId: string, keyId: string): void;
  // messages
  insertMessage(input: NewMessageInput): MessageRow;
  getMessage(id: string): MessageRow | undefined;
  listMessages(roomId: string, opts?: { afterSeq?: number; limit?: number }): MessageRow[]; // 旧→新
  softDeleteMessage(id: string, at: string): void;
  countRepliesTo(agentId: string, sinceIso: string): number;
  // events
  insertEvent(input: NewEventInput): void;
  getEvent(id: string): EventRow | undefined;
  decideEvent(id: string, status: EventRow['status'], reason: string | null, decidedAt: string, latencyMs: number | null): void;
  markAllDeliveredAsTimeout(at: string): number;
  eventMetrics(agentId: string, sinceIso: string): EventMetrics;
  lastPostedLatency(agentId: string): number | null;
  // reactions
  addReaction(messageId: string, keyId: string, at: string): boolean; // false = 重复点赞
  countLikes(messageId: string): number;
  countLikesByAgent(agentId: string, sinceIso: string): number;
  countLikesByKeySince(keyId: string, sinceIso: string): number;
  // stats & scores
  bumpStats(agentId: string, patch: StatsPatch): void;
  getStats(agentId: string): Required<StatsPatch> & { agentId: string };
  upsertScore(row: ScoreRow): void;
  getScore(agentId: string): ScoreRow | undefined;
  topScores(n: number): ScoreRow[];
  // audit
  insertAudit(input: AuditInput): void;
  listAudit(limit: number): AuditRow[];
}
```

`apps/server/src/storage/sqlite.ts`（本任务先写构造、建表、映射器与 keys/agents；后续任务在同类内追加方法）：

```ts
import Database from 'better-sqlite3';
import { newId } from '../ids.js';
import type {
  AgentRow, KeyRow,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, label TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  last_seen_at TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', last_seen_at TEXT,
  created_at TEXT NOT NULL, UNIQUE(key_id, name)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, topic TEXT,
  visibility TEXT NOT NULL DEFAULT 'private', owner_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', invite_code TEXT UNIQUE,
  cooldown_ms INTEGER NOT NULL DEFAULT 10000, max_agents INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_agents (
  room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL, key_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL, PRIMARY KEY (room_id, key_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
  sender_kind TEXT NOT NULL, sender_name TEXT NOT NULL,
  agent_id TEXT, key_id TEXT, text TEXT NOT NULL, reply_to TEXT,
  deleted_at TEXT, created_at TEXT NOT NULL, UNIQUE(room_id, seq)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  trigger_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered',
  reason TEXT, notified_at TEXT NOT NULL, decided_at TEXT, latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, key_id)
);
CREATE TABLE IF NOT EXISTS agent_stats (
  agent_id TEXT PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0,
  posted INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  timeout INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  throttled INTEGER NOT NULL DEFAULT 0, replies_received INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_scores (
  agent_id TEXT PRIMARY KEY, behavior INTEGER NOT NULL, heat INTEGER NOT NULL,
  total INTEGER NOT NULL, tier TEXT NOT NULL, likes_7d INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, notified_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, notified_at);
CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(key_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_key_time ON reactions(key_id, created_at);
`;

export class SqliteStorage {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- 行映射 ----------

  private mapKey(r: any): KeyRow {
    return {
      id: r.id, hash: r.hash, label: r.label, status: r.status,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, notes: r.notes,
    };
  }

  private mapAgent(r: any): AgentRow {
    return {
      id: r.id, keyId: r.key_id, name: r.name, status: r.status,
      lastSeenAt: r.last_seen_at, createdAt: r.created_at,
    };
  }

  // ---------- keys ----------

  createKey(input: { id: string; hash: string; label: string | null; createdAt: string }): KeyRow {
    this.db.prepare(
      `INSERT INTO keys (id, hash, label, created_at) VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.hash, input.label, input.createdAt);
    return {
      id: input.id, hash: input.hash, label: input.label,
      status: 'active', createdAt: input.createdAt, lastSeenAt: null, notes: null,
    };
  }

  getKeyByHash(hash: string): KeyRow | undefined {
    const r = this.db.prepare(`SELECT * FROM keys WHERE hash = ?`).get(hash);
    return r ? this.mapKey(r) : undefined;
  }

  getKey(id: string): KeyRow | undefined {
    const r = this.db.prepare(`SELECT * FROM keys WHERE id = ?`).get(id);
    return r ? this.mapKey(r) : undefined;
  }

  setKeyStatus(id: string, status: 'active' | 'banned'): void {
    this.db.prepare(`UPDATE keys SET status = ? WHERE id = ?`).run(status, id);
  }

  touchKey(id: string, at: string): void {
    this.db.prepare(`UPDATE keys SET last_seen_at = ? WHERE id = ?`).run(at, id);
  }

  listKeys(): KeyRow[] {
    return (this.db.prepare(`SELECT * FROM keys ORDER BY created_at`).all() as any[]).map((r) => this.mapKey(r));
  }

  // ---------- agents ----------

  upsertAgent(input: { id?: string; keyId: string; name: string; at: string }): AgentRow {
    const existing = this.db.prepare(
      `SELECT * FROM agents WHERE key_id = ? AND name = ?`,
    ).get(input.keyId, input.name) as any;
    if (existing) {
      this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(input.at, existing.id);
      return this.mapAgent(existing);
    }
    if (input.id) {
      const clash = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(input.id) as any;
      if (clash && clash.key_id !== input.keyId) throw new Error('agent_id_mismatch');
    }
    const id = input.id ?? newId('ag');
    this.db.prepare(
      `INSERT INTO agents (id, key_id, name, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.keyId, input.name, input.at, input.at);
    return { id, keyId: input.keyId, name: input.name, status: 'offline', lastSeenAt: input.at, createdAt: input.at };
  }

  getAgent(id: string): AgentRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    return r ? this.mapAgent(r) : undefined;
  }

  setAgentStatus(id: string, status: AgentRow['status'], at: string): void {
    this.db.prepare(`UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?`).run(status, at, id);
  }

  listAgentsByKey(keyId: string): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE key_id = ? ORDER BY created_at`).all(keyId) as any[])
      .map((r) => this.mapAgent(r));
  }

  listAgents(): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY created_at`).all() as any[]).map((r) => this.mapAgent(r));
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test/storage-keys.test.ts && npx tsc --noEmit -p apps/server`
Expected: 8 个测试 PASS，typecheck 无输出。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add ids and sqlite storage for keys and agents"
```

---

### Task 3: 存储 rooms / room_agents / members

**Files:**
- Modify: `apps/server/src/storage/sqlite.ts`（在 `SqliteStorage` 类内追加 rooms / room_agents / members 三组方法与 `mapRoom`、`mapRoomAgent` 映射器）
- Test: `apps/server/test/storage-rooms.test.ts`

**Interfaces:**
- Consumes: `newId`（Task 2）、`Storage` 接口的 rooms/room_agents/members 签名（Task 2）
- Produces: `SqliteStorage.ensureLobby / createRoom / getRoom / getRoomByInviteCode / listRooms / updateRoom / addRoomAgent / getRoomAgent / setRoomAgentStatus / removeRoomAgent / listRoomAgents / listWaitingAgents / listRoomsOfAgent / countRoomAgents / countKeyAgentsInRoom / addMember / getMember / removeMember`

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-rooms.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

function setup() {
  const s = new SqliteStorage(':memory:');
  s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
  return s;
}

describe('rooms', () => {
  it('ensureLobby 幂等', () => {
    const s = setup();
    const r1 = s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    const r2 = s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't2' });
    expect(r1.id).toBe('lobby');
    expect(r2.id).toBe('lobby');
    expect(r1.visibility).toBe('public');
  });
  it('创建私有房间并按邀请码查询', () => {
    const s = setup();
    const room = s.createRoom({
      id: 'rm_1', title: '深夜哲学', topic: '意识是什么', visibility: 'private',
      ownerKeyId: 'key_1', inviteCode: 'abc123', cooldownMs: 10000, maxAgents: 20, at: 't1',
    });
    expect(room.status).toBe('active');
    expect(s.getRoomByInviteCode('abc123')?.id).toBe('rm_1');
    expect(s.getRoomByInviteCode('nope')).toBeUndefined();
  });
  it('listRooms 按 visibility 过滤', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    s.createRoom({
      id: 'rm_1', title: '私房', topic: null, visibility: 'private',
      ownerKeyId: 'key_1', inviteCode: 'c1', cooldownMs: 10000, maxAgents: 20, at: 't1',
    });
    expect(s.listRooms()).toHaveLength(2);
    expect(s.listRooms('public')).toHaveLength(1);
    expect(s.listRooms('private')).toHaveLength(1);
  });
  it('updateRoom 局部更新', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    const r = s.updateRoom('lobby', { status: 'paused', cooldownMs: 5000 });
    expect(r.status).toBe('paused');
    expect(r.cooldownMs).toBe(5000);
    expect(r.title).toBe('大厅');
  });
});

describe('room_agents', () => {
  it('加入/状态/候补列表/计数', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 1, at: 't1' });
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't1' });
    s.upsertAgent({ id: 'ag_2', keyId: 'key_1', name: '老豆', at: 't1' });
    s.upsertAgent({ id: 'ag_3', keyId: 'key_1', name: '三豆', at: 't1' });
    s.addRoomAgent('lobby', 'ag_1', 'active', 't1');
    s.addRoomAgent('lobby', 'ag_2', 'waiting', 't2');
    s.addRoomAgent('lobby', 'ag_3', 'waiting', 't3');
    expect(s.countRoomAgents('lobby', 'active')).toBe(1);
    expect(s.listWaitingAgents('lobby').map((r) => r.agentId)).toEqual(['ag_2', 'ag_3']);
    s.setRoomAgentStatus('lobby', 'ag_2', 'active');
    expect(s.countRoomAgents('lobby', 'active')).toBe(2);
    expect(s.listRoomsOfAgent('ag_2')).toHaveLength(1);
    s.removeRoomAgent('lobby', 'ag_2');
    expect(s.getRoomAgent('lobby', 'ag_2')).toBeUndefined();
  });
  it('countKeyAgentsInRoom 只统计 active/waiting', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    for (const [id, name] of [['ag_1', 'a'], ['ag_2', 'b'], ['ag_3', 'c']] as const) {
      s.upsertAgent({ id, keyId: 'key_1', name, at: 't1' });
      s.addRoomAgent('lobby', id, 'active', 't1');
    }
    s.setRoomAgentStatus('lobby', 'ag_3', 'kicked');
    expect(s.countKeyAgentsInRoom('lobby', 'key_1')).toBe(2);
  });
});

describe('room_members', () => {
  it('成员增查删', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    s.addMember('lobby', 'key_1', 'host', 't1');
    expect(s.getMember('lobby', 'key_1')?.role).toBe('host');
    s.removeMember('lobby', 'key_1');
    expect(s.getMember('lobby', 'key_1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-rooms.test.ts`
Expected: FAIL（`ensureLobby is not a function`）

- [ ] **Step 3: 实现**

在 `apps/server/src/storage/sqlite.ts` 的 import 行加入 `RoomAgentRow, RoomMemberRow, RoomRow` 类型，并在 `SqliteStorage` 类内追加：

```ts
  // ---------- 行映射 ----------

  private mapRoom(r: any): RoomRow {
    return {
      id: r.id, title: r.title, topic: r.topic, visibility: r.visibility,
      ownerKeyId: r.owner_key_id, status: r.status, inviteCode: r.invite_code,
      cooldownMs: r.cooldown_ms, maxAgents: r.max_agents, createdAt: r.created_at,
    };
  }

  private mapRoomAgent(r: any): RoomAgentRow {
    return { roomId: r.room_id, agentId: r.agent_id, status: r.status, joinedAt: r.joined_at };
  }

  // ---------- rooms ----------

  private insertRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string | null;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow {
    this.db.prepare(
      `INSERT INTO rooms (id, title, topic, visibility, owner_key_id, invite_code, cooldown_ms, max_agents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.title, input.topic, input.visibility,
      input.ownerKeyId, input.inviteCode, input.cooldownMs, input.maxAgents, input.at,
    );
    return {
      id: input.id, title: input.title, topic: input.topic, visibility: input.visibility,
      ownerKeyId: input.ownerKeyId, status: 'active', inviteCode: input.inviteCode,
      cooldownMs: input.cooldownMs, maxAgents: input.maxAgents, createdAt: input.at,
    };
  }

  ensureLobby(input: { title: string; maxAgents: number; at: string }): RoomRow {
    const existing = this.getRoom('lobby');
    if (existing) return existing;
    return this.insertRoom({
      id: 'lobby', title: input.title, topic: null, visibility: 'public',
      ownerKeyId: null, inviteCode: null, cooldownMs: 10000, maxAgents: input.maxAgents, at: input.at,
    });
  }

  createRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow {
    return this.insertRoom(input);
  }

  getRoom(id: string): RoomRow | undefined {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id);
    return r ? this.mapRoom(r) : undefined;
  }

  getRoomByInviteCode(code: string): RoomRow | undefined {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE invite_code = ?`).get(code);
    return r ? this.mapRoom(r) : undefined;
  }

  listRooms(visibility?: 'public' | 'private'): RoomRow[] {
    const rows = visibility
      ? this.db.prepare(`SELECT * FROM rooms WHERE visibility = ? ORDER BY created_at`).all(visibility)
      : this.db.prepare(`SELECT * FROM rooms ORDER BY created_at`).all();
    return (rows as any[]).map((r) => this.mapRoom(r));
  }

  updateRoom(
    id: string,
    patch: Partial<Pick<RoomRow, 'title' | 'topic' | 'status' | 'cooldownMs' | 'maxAgents'>>,
  ): RoomRow {
    const col: Record<string, string> = {
      title: 'title', topic: 'topic', status: 'status',
      cooldownMs: 'cooldown_ms', maxAgents: 'max_agents',
    };
    for (const [k, v] of Object.entries(patch)) {
      this.db.prepare(`UPDATE rooms SET ${col[k]} = ? WHERE id = ?`).run(v, id);
    }
    return this.getRoom(id)!;
  }

  // ---------- room_agents ----------

  addRoomAgent(roomId: string, agentId: string, status: 'active' | 'waiting', at: string): void {
    this.db.prepare(
      `INSERT INTO room_agents (room_id, agent_id, status, joined_at) VALUES (?, ?, ?, ?)`,
    ).run(roomId, agentId, status, at);
  }

  getRoomAgent(roomId: string, agentId: string): RoomAgentRow | undefined {
    const r = this.db.prepare(
      `SELECT * FROM room_agents WHERE room_id = ? AND agent_id = ?`,
    ).get(roomId, agentId);
    return r ? this.mapRoomAgent(r) : undefined;
  }

  setRoomAgentStatus(roomId: string, agentId: string, status: RoomAgentRow['status']): void {
    this.db.prepare(
      `UPDATE room_agents SET status = ? WHERE room_id = ? AND agent_id = ?`,
    ).run(status, roomId, agentId);
  }

  removeRoomAgent(roomId: string, agentId: string): void {
    this.db.prepare(
      `DELETE FROM room_agents WHERE room_id = ? AND agent_id = ?`,
    ).run(roomId, agentId);
  }

  listRoomAgents(roomId: string): RoomAgentRow[] {
    return (
      this.db.prepare(`SELECT * FROM room_agents WHERE room_id = ? ORDER BY joined_at`).all(roomId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  listWaitingAgents(roomId: string): RoomAgentRow[] {
    return (
      this.db.prepare(
        `SELECT * FROM room_agents WHERE room_id = ? AND status = 'waiting' ORDER BY joined_at`,
      ).all(roomId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  listRoomsOfAgent(agentId: string): RoomAgentRow[] {
    return (
      this.db.prepare(`SELECT * FROM room_agents WHERE agent_id = ?`).all(agentId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  countRoomAgents(roomId: string, status: RoomAgentRow['status']): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM room_agents WHERE room_id = ? AND status = ?`,
      ).get(roomId, status) as any
    ).c;
  }

  countKeyAgentsInRoom(roomId: string, keyId: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM room_agents ra JOIN agents a ON a.id = ra.agent_id
         WHERE ra.room_id = ? AND a.key_id = ? AND ra.status IN ('active', 'waiting')`,
      ).get(roomId, keyId) as any
    ).c;
  }

  // ---------- members ----------

  addMember(roomId: string, keyId: string, role: 'host' | 'member', at: string): void {
    this.db.prepare(
      `INSERT INTO room_members (room_id, key_id, role, joined_at) VALUES (?, ?, ?, ?)`,
    ).run(roomId, keyId, role, at);
  }

  getMember(roomId: string, keyId: string): RoomMemberRow | undefined {
    const r = this.db.prepare(
      `SELECT * FROM room_members WHERE room_id = ? AND key_id = ?`,
    ).get(roomId, keyId);
    return r
      ? { roomId: r.room_id, keyId: r.key_id, role: r.role, joinedAt: r.joined_at }
      : undefined;
  }

  removeMember(roomId: string, keyId: string): void {
    this.db.prepare(
      `DELETE FROM room_members WHERE room_id = ? AND key_id = ?`,
    ).run(roomId, keyId);
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（含 Task 2 的 8 个）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add storage for rooms and membership"
```

---

### Task 4: 存储 messages / events

**Files:**
- Modify: `apps/server/src/storage/sqlite.ts`（追加 messages / events 两组方法与映射器）
- Test: `apps/server/test/storage-messages.test.ts`

**Interfaces:**
- Consumes: `newId`、`Storage` 接口 messages/events 签名
- Produces: `insertMessage / getMessage / listMessages / softDeleteMessage / countRepliesTo / insertEvent / getEvent / decideEvent / markAllDeliveredAsTimeout / eventMetrics / lastPostedLatency`

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-messages.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

function msg(s: SqliteStorage, roomId: string, text: string, extra: Partial<Parameters<SqliteStorage['insertMessage']>[0]> = {}) {
  return s.insertMessage({
    roomId, senderKind: 'human', senderName: '阿伟',
    agentId: null, keyId: 'key_1', text, replyTo: null, createdAt: '2026-10-26T00:00:00.000Z',
    ...extra,
  });
}

describe('messages', () => {
  it('seq 在房间内自增', () => {
    const s = new SqliteStorage(':memory:');
    const m1 = msg(s, 'lobby', '一');
    const m2 = msg(s, 'lobby', '二');
    const other = msg(s, 'rm_9', '别的房间');
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(other.seq).toBe(1);
  });
  it('listMessages 按 seq 升序、支持 afterSeq 与 limit', () => {
    const s = new SqliteStorage(':memory:');
    for (const t of ['一', '二', '三', '四']) msg(s, 'lobby', t);
    expect(s.listMessages('lobby').map((m) => m.text)).toEqual(['一', '二', '三', '四']);
    expect(s.listMessages('lobby', { afterSeq: 2 }).map((m) => m.text)).toEqual(['三', '四']);
    expect(s.listMessages('lobby', { limit: 2 }).map((m) => m.text)).toEqual(['三', '四']);
  });
  it('软删除', () => {
    const s = new SqliteStorage(':memory:');
    const m = msg(s, 'lobby', '违规内容');
    s.softDeleteMessage(m.id, 't');
    expect(s.getMessage(m.id)?.deletedAt).toBe('t');
  });
  it('countRepliesTo 统计别人回复我的消息数', () => {
    const s = new SqliteStorage(':memory:');
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    const mine = msg(s, 'lobby', '我说', { senderKind: 'agent', senderName: '小豆', agentId: 'ag_1' });
    msg(s, 'lobby', '回复1', { replyTo: mine.id });
    msg(s, 'lobby', '回复2', { replyTo: mine.id });
    const other = msg(s, 'lobby', '别人的', { senderKind: 'system', senderName: 'sys' });
    msg(s, 'lobby', '回复3', { replyTo: other.id });
    expect(s.countRepliesTo('ag_1', '2020-01-01T00:00:00.000Z')).toBe(2);
  });
});

describe('events', () => {
  it('插入 delivered 并 decide', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'lobby', agentId: 'ag_1', triggerMessageId: 'm_1', notifiedAt: 't1' });
    expect(s.getEvent('ev_1')?.status).toBe('delivered');
    s.decideEvent('ev_1', 'posted', null, 't2', 1200);
    const ev = s.getEvent('ev_1')!;
    expect(ev.status).toBe('posted');
    expect(ev.latencyMs).toBe(1200);
  });
  it('markAllDeliveredAsTimeout 只影响未决', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' });
    s.insertEvent({ id: 'ev_2', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' });
    s.decideEvent('ev_2', 'skipped', null, 't', null);
    expect(s.markAllDeliveredAsTimeout('boot')).toBe(1);
    expect(s.getEvent('ev_1')?.status).toBe('timeout');
    expect(s.getEvent('ev_1')?.reason).toBe('server_restart');
    expect(s.getEvent('ev_2')?.status).toBe('skipped');
  });
  it('eventMetrics 分组统计与延迟样本', () => {
    const s = new SqliteStorage(':memory:');
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    const row = { roomId: 'r', agentId: 'ag_1', triggerMessageId: 'm', notifiedAt: '2026-10-20T00:00:00.000Z' };
    s.insertEvent({ id: 'ev_1', ...row });
    s.insertEvent({ id: 'ev_2', ...row });
    s.insertEvent({ id: 'ev_3', ...row });
    s.insertEvent({ id: 'ev_4', ...row });
    s.decideEvent('ev_1', 'posted', null, 't', 3000);
    s.decideEvent('ev_2', 'posted', null, 't', 9000);
    s.decideEvent('ev_3', 'timeout', null, 't', null);
    s.decideEvent('ev_4', 'rejected', 'throttled', 't', null);
    const m = s.eventMetrics('ag_1', '2026-10-01T00:00:00.000Z');
    expect(m.delivered).toBe(4);
    expect(m.posted).toBe(2);
    expect(m.timeout).toBe(1);
    expect(m.rejected).toBe(1);
    expect(m.throttled).toBe(1);
    expect(m.latencies).toEqual([3000, 9000]);
  });
  it('lastPostedLatency 取最近一次', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't1' });
    s.insertEvent({ id: 'ev_2', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't2' });
    s.decideEvent('ev_1', 'posted', null, 't', 1000);
    s.decideEvent('ev_2', 'posted', null, 't', 2000);
    expect(s.lastPostedLatency('a')).toBe(2000);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-messages.test.ts`
Expected: FAIL（`insertMessage is not a function`）

- [ ] **Step 3: 实现**

在 `apps/server/src/storage/sqlite.ts` 顶部类型导入加入 `EventMetrics, EventRow, MessageRow, NewEventInput, NewMessageInput`，并在类内追加：

```ts
  // ---------- 行映射 ----------

  private mapMessage(r: any): MessageRow {
    return {
      id: r.id, roomId: r.room_id, seq: r.seq, senderKind: r.sender_kind,
      senderName: r.sender_name, agentId: r.agent_id, keyId: r.key_id,
      text: r.text, replyTo: r.reply_to, deletedAt: r.deleted_at, createdAt: r.created_at,
    };
  }

  // ---------- messages ----------

  insertMessage(input: NewMessageInput): MessageRow {
    const id = newId('m');
    const seq = (
      this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room_id = ?`)
        .get(input.roomId) as any
    ).s + 1;
    this.db.prepare(
      `INSERT INTO messages (id, room_id, seq, sender_kind, sender_name, agent_id, key_id, text, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.roomId, seq, input.senderKind, input.senderName,
      input.agentId, input.keyId, input.text, input.replyTo, input.createdAt,
    );
    return {
      id, roomId: input.roomId, seq, senderKind: input.senderKind, senderName: input.senderName,
      agentId: input.agentId, keyId: input.keyId, text: input.text,
      replyTo: input.replyTo, deletedAt: null, createdAt: input.createdAt,
    };
  }

  getMessage(id: string): MessageRow | undefined {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
    return r ? this.mapMessage(r) : undefined;
  }

  listMessages(roomId: string, opts?: { afterSeq?: number; limit?: number }): MessageRow[] {
    const limit = opts?.limit ?? 200;
    const rows = opts?.afterSeq !== undefined
      ? this.db.prepare(
          `SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        ).all(roomId, opts.afterSeq, limit)
      : this.db.prepare(
          `SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
        ).all(roomId, limit);
    return (rows as any[]).map((r) => this.mapMessage(r));
  }

  softDeleteMessage(id: string, at: string): void {
    this.db.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run(at, id);
  }

  countRepliesTo(agentId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM messages r JOIN messages m ON r.reply_to = m.id
         WHERE m.agent_id = ? AND r.created_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
  }

  // ---------- events ----------

  insertEvent(input: NewEventInput): void {
    this.db.prepare(
      `INSERT INTO events (id, room_id, agent_id, trigger_message_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.roomId, input.agentId, input.triggerMessageId, input.notifiedAt);
  }

  getEvent(id: string): EventRow | undefined {
    const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
    return r
      ? {
          id: r.id, roomId: r.room_id, agentId: r.agent_id,
          triggerMessageId: r.trigger_message_id, status: r.status, reason: r.reason,
          notifiedAt: r.notified_at, decidedAt: r.decided_at, latencyMs: r.latency_ms,
        }
      : undefined;
  }

  decideEvent(
    id: string, status: EventRow['status'], reason: string | null,
    decidedAt: string, latencyMs: number | null,
  ): void {
    this.db.prepare(
      `UPDATE events SET status = ?, reason = ?, decided_at = ?, latency_ms = ? WHERE id = ?`,
    ).run(status, reason, decidedAt, latencyMs, id);
  }

  markAllDeliveredAsTimeout(at: string): number {
    const r = this.db.prepare(
      `UPDATE events SET status = 'timeout', reason = 'server_restart', decided_at = ? WHERE status = 'delivered'`,
    ).run(at);
    return r.changes;
  }

  eventMetrics(agentId: string, sinceIso: string): EventMetrics {
    const m: EventMetrics = {
      delivered: 0, posted: 0, skipped: 0, timeout: 0, rejected: 0, throttled: 0, latencies: [],
    };
    for (const r of this.db.prepare(
      `SELECT status, COUNT(*) AS c FROM events WHERE agent_id = ? AND notified_at >= ? GROUP BY status`,
    ).all(agentId, sinceIso) as any[]) {
      if (r.status in m) (m as any)[r.status] = r.c;
    }
    m.throttled = (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM events
         WHERE agent_id = ? AND status = 'rejected' AND reason = 'throttled' AND notified_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
    m.latencies = (
      this.db.prepare(
        `SELECT latency_ms FROM events
         WHERE agent_id = ? AND status = 'posted' AND notified_at >= ? AND latency_ms IS NOT NULL
         ORDER BY latency_ms LIMIT 500`,
      ).all(agentId, sinceIso) as any[]
    ).map((r) => r.latency_ms);
    return m;
  }

  lastPostedLatency(agentId: string): number | null {
    const r = this.db.prepare(
      `SELECT latency_ms FROM events
       WHERE agent_id = ? AND status = 'posted' AND latency_ms IS NOT NULL
       ORDER BY notified_at DESC LIMIT 1`,
    ).get(agentId) as any;
    return r ? r.latency_ms : null;
  }
```

注意 `markAllDeliveredAsTimeout` 的 reason 固定为 `server_restart`，与规格第 12 节「服务重启→未决 event 记 timeout」对应。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add storage for messages and events"
```

---

### Task 5: 存储 reactions / stats / scores / audit，实现 Storage 接口

**Files:**
- Modify: `apps/server/src/storage/sqlite.ts`（追加四组方法；类声明改为 `implements Storage`）
- Test: `apps/server/test/storage-social.test.ts`

**Interfaces:**
- Produces: `SqliteStorage implements Storage` —— 存储层自此完整，引擎任务可直接依赖 `Storage` 接口

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-social.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

function setup() {
  const s = new SqliteStorage(':memory:');
  s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
  s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 't' });
  s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
  const m = s.insertMessage({
    roomId: 'lobby', senderKind: 'agent', senderName: '小豆',
    agentId: 'ag_1', keyId: 'key_1', text: '说点什么', replyTo: null,
    createdAt: '2026-10-26T00:00:00.000Z',
  });
  return { s, m };
}

describe('reactions', () => {
  it('同一 key 重复点赞返回 false', () => {
    const { s, m } = setup();
    expect(s.addReaction(m.id, 'key_2', 't1')).toBe(true);
    expect(s.addReaction(m.id, 'key_2', 't2')).toBe(false);
    expect(s.countLikes(m.id)).toBe(1);
  });
  it('countLikesByAgent 通过消息归属 agent', () => {
    const { s, m } = setup();
    s.addReaction(m.id, 'key_2', '2026-10-26T00:00:00.000Z');
    expect(s.countLikesByAgent('ag_1', '2026-10-01T00:00:00.000Z')).toBe(1);
    expect(s.countLikesByAgent('ag_1', '2027-01-01T00:00:00.000Z')).toBe(0);
  });
  it('countLikesByKeySince 限频查询', () => {
    const { s, m } = setup();
    s.addReaction(m.id, 'key_2', '2026-10-26T01:00:00.000Z');
    expect(s.countLikesByKeySince('key_2', '2026-10-26T00:30:00.000Z')).toBe(1);
    expect(s.countLikesByKeySince('key_2', '2026-10-26T02:00:00.000Z')).toBe(0);
  });
});

describe('stats & scores', () => {
  it('bumpStats 累加、getStats 缺省为 0', () => {
    const { s } = setup();
    expect(s.getStats('ag_1').delivered).toBe(0);
    s.bumpStats('ag_1', { delivered: 1 });
    s.bumpStats('ag_1', { delivered: 1, posted: 1 });
    const st = s.getStats('ag_1');
    expect(st.delivered).toBe(2);
    expect(st.posted).toBe(1);
    expect(st.repliesReceived).toBe(0);
  });
  it('upsertScore 覆盖旧值，topScores 按 total 降序', () => {
    const { s } = setup();
    s.upsertScore({ agentId: 'ag_1', behavior: 60, heat: 50, total: 57, tier: 'chatter', likes7d: 4, computedAt: 't' });
    s.upsertScore({ agentId: 'ag_1', behavior: 80, heat: 0, total: 56, tier: 'star', likes7d: 0, computedAt: 't2' });
    expect(s.getScore('ag_1')?.total).toBe(56);
    s.upsertScore({ agentId: 'ag_2', behavior: 90, heat: 100, total: 93, tier: 'legend', likes7d: 100, computedAt: 't' });
    expect(s.topScores(2).map((r) => r.agentId)).toEqual(['ag_2', 'ag_1']);
  });
});

describe('audit', () => {
  it('写入并按时间倒序读取', () => {
    const s = new SqliteStorage(':memory:');
    s.insertAudit({ action: 'ban_key', targetType: 'key', targetId: 'key_1', detail: '{}', createdAt: 't1' });
    s.insertAudit({ action: 'kick_agent', targetType: 'agent', targetId: 'ag_1', detail: '{}', createdAt: 't2' });
    const rows = s.listAudit(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe('kick_agent');
  });
});
```

注意测试里 `upsertScore` 用了不存在的 `ag_2`——`topScores` 查询不 JOIN agents 表，所以合法；这正是我们要的行为（分数独立于 agent 行存在）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-social.test.ts`
Expected: FAIL（`addReaction is not a function`）

- [ ] **Step 3: 实现**

在 `apps/server/src/storage/sqlite.ts` 顶部类型导入加入 `AuditInput, AuditRow, ScoreRow, StatsPatch`，类声明改为：

```ts
export class SqliteStorage implements Storage {
```

（同时把 `import type { ... } from './types.js'` 补全为包含 `Storage`。）在类内追加：

```ts
  // ---------- reactions ----------

  addReaction(messageId: string, keyId: string, at: string): boolean {
    try {
      this.db.prepare(
        `INSERT INTO reactions (message_id, key_id, created_at) VALUES (?, ?, ?)`,
      ).run(messageId, keyId, at);
      return true;
    } catch {
      return false;
    }
  }

  countLikes(messageId: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?`)
        .get(messageId) as any
    ).c;
  }

  countLikesByAgent(agentId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM reactions r JOIN messages m ON m.id = r.message_id
         WHERE m.agent_id = ? AND r.created_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
  }

  countLikesByKeySince(keyId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM reactions WHERE key_id = ? AND created_at >= ?`,
      ).get(keyId, sinceIso) as any
    ).c;
  }

  // ---------- stats & scores ----------

  bumpStats(agentId: string, patch: StatsPatch): void {
    this.db.prepare(
      `INSERT INTO agent_stats (agent_id, delivered, posted, skipped, timeout, rejected, throttled, replies_received, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         delivered = delivered + excluded.delivered,
         posted = posted + excluded.posted,
         skipped = skipped + excluded.skipped,
         timeout = timeout + excluded.timeout,
         rejected = rejected + excluded.rejected,
         throttled = throttled + excluded.throttled,
         replies_received = replies_received + excluded.replies_received,
         updated_at = excluded.updated_at`,
    ).run(
      agentId, patch.delivered ?? 0, patch.posted ?? 0, patch.skipped ?? 0,
      patch.timeout ?? 0, patch.rejected ?? 0, patch.throttled ?? 0,
      patch.repliesReceived ?? 0, new Date().toISOString(),
    );
  }

  getStats(agentId: string): Required<StatsPatch> & { agentId: string } {
    const r = this.db.prepare(`SELECT * FROM agent_stats WHERE agent_id = ?`).get(agentId) as any;
    if (!r) {
      return {
        agentId, delivered: 0, posted: 0, skipped: 0,
        timeout: 0, rejected: 0, throttled: 0, repliesReceived: 0,
      };
    }
    return {
      agentId, delivered: r.delivered, posted: r.posted, skipped: r.skipped,
      timeout: r.timeout, rejected: r.rejected, throttled: r.throttled,
      repliesReceived: r.replies_received,
    };
  }

  upsertScore(row: ScoreRow): void {
    this.db.prepare(
      `INSERT INTO agent_scores (agent_id, behavior, heat, total, tier, likes_7d, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         behavior = excluded.behavior, heat = excluded.heat, total = excluded.total,
         tier = excluded.tier, likes_7d = excluded.likes_7d, computed_at = excluded.computed_at`,
    ).run(row.agentId, row.behavior, row.heat, row.total, row.tier, row.likes7d, row.computedAt);
  }

  getScore(agentId: string): ScoreRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agent_scores WHERE agent_id = ?`).get(agentId) as any;
    return r
      ? {
          agentId: r.agent_id, behavior: r.behavior, heat: r.heat, total: r.total,
          tier: r.tier, likes7d: r.likes_7d, computedAt: r.computed_at,
        }
      : undefined;
  }

  topScores(n: number): ScoreRow[] {
    return (
      this.db.prepare(`SELECT * FROM agent_scores ORDER BY total DESC LIMIT ?`).all(n) as any[]
    ).map((r) => ({
      agentId: r.agent_id, behavior: r.behavior, heat: r.heat, total: r.total,
      tier: r.tier, likes7d: r.likes_7d, computedAt: r.computed_at,
    }));
  }

  // ---------- audit ----------

  insertAudit(input: AuditInput): void {
    this.db.prepare(
      `INSERT INTO admin_audit (id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId('au'), input.action, input.targetType, input.targetId, input.detail, input.createdAt);
  }

  listAudit(limit: number): AuditRow[] {
    return (
      this.db.prepare(`SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]
    ).map((r) => ({
      id: r.id, action: r.action, targetType: r.target_type,
      targetId: r.target_id, detail: r.detail, createdAt: r.created_at,
    }));
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。typecheck 通过说明 `SqliteStorage` 的方法签名与 `Storage` 接口完全一致——这是 Task 5 的验收点。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add storage for reactions stats scores and audit"
```

---

### Task 6: MemoryBus + 房间引擎（成员关系：加入/候补/踢人/暂停）

**Files:**
- Create: `apps/server/src/topics.ts`
- Create: `apps/server/src/bus.ts`
- Create: `apps/server/src/engine/errors.ts`
- Create: `apps/server/src/engine/room.ts`（本任务：构造、成员关系与在场列表；消息与派发在 Task 7/8 追加）
- Test: `apps/server/test/helpers.ts`, `apps/server/test/engine-rooms.test.ts`

**Interfaces:**
- Consumes: `Storage`（Task 5）、`AgentPresence`、`DEFAULT_LIMITS`、`Limits`（协议包）
- Produces:
  - `Topics`（messageNew/eventDispatch/presence/roomUpdate/agentState/reaction）
  - `MemoryBus implements Bus`（`emit(topic, payload)` / `on(topic, handler) => unsubscribe`）
  - `EngineError`（`code` 属性）
  - `RoomEngine`（本任务方法）：`joinRoom(agentId, roomId) => {status:'active'|'waiting'}`、`leaveRoom(agentId, roomId)`、`kickAgent(roomId, agentId)`、`pauseRoom(roomId)`、`resumeRoom(roomId)`、`listPresence(roomId) => AgentPresence[]`

- [ ] **Step 1: 写公共测试助手与失败测试**

`apps/server/test/helpers.ts` 全文（后续所有引擎测试复用）：

```ts
import { DEFAULT_LIMITS, type Limits } from '@ai-smash/protocol';
import { MemoryBus } from '../src/bus.js';
import { RoomEngine } from '../src/engine/room.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

export interface World {
  storage: SqliteStorage;
  bus: MemoryBus;
  engine: RoomEngine;
  keyId: string;
  limits: Limits;
}

export function makeWorld(overrides: Partial<Limits> = {}): World {
  const storage = new SqliteStorage(':memory:');
  const bus = new MemoryBus();
  const at = new Date().toISOString();
  const key = storage.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: at });
  storage.ensureLobby({ title: '大厅', maxAgents: 50, at });
  const limits = {
    ...DEFAULT_LIMITS,
    // 默认把 deadline 拉到 1 小时，避免测试里未处理的派发被超时打断；
    // 超时相关测试显式传 deadlineMs 覆盖。
    deadlineMs: 3_600_000,
    ...overrides,
  } as Limits;
  const engine = new RoomEngine({ storage, bus, limits });
  return { storage, bus, engine, keyId: key.id, limits };
}

export function addAgent(
  w: World, name: string, id?: string, keyId: string = w.keyId,
) {
  const at = new Date().toISOString();
  const agent = w.storage.upsertAgent({ id, keyId, name, at });
  w.storage.setAgentStatus(agent.id, 'online', at);
  return agent;
}

export function join(w: World, agentId: string, roomId = 'lobby') {
  return w.engine.joinRoom(agentId, roomId);
}

export function record(bus: MemoryBus, topic: string): any[] {
  const got: any[] = [];
  bus.on(topic, (p: any) => got.push(p));
  return got;
}
```

`apps/server/test/engine-rooms.test.ts` 全文：

```ts
import { Topics } from '../src/topics.js';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/engine/errors.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

describe('joinRoom', () => {
  it('未满时直接成为正式成员', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    expect(join(w, a.id).status).toBe('active');
    expect(w.storage.countRoomAgents('lobby', 'active')).toBe(1);
  });

  it('满员时进入候补，退出后按顺序转正', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    const a1 = addAgent(w, '甲');
    const a2 = addAgent(w, '乙');
    expect(join(w, a1.id).status).toBe('active');
    expect(join(w, a2.id).status).toBe('waiting');
    w.engine.leaveRoom(a1.id, 'lobby');
    expect(w.storage.getRoomAgent('lobby', a2.id)?.status).toBe('active');
  });

  it('被踢后禁止再次加入', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.kickAgent('lobby', a.id);
    expect(() => join(w, a.id)).toThrowError(EngineError);
    try {
      join(w, a.id);
    } catch (e) {
      expect((e as EngineError).code).toBe('kicked');
    }
  });

  it('同 key 同房间超过 3 个 agent 拒绝（forbidden）', () => {
    const w = makeWorld();
    const agents = ['a', 'b', 'c', 'd'].map((n) => addAgent(w, n));
    for (const a of agents.slice(0, 3)) join(w, a.id);
    expect(() => join(w, agents[3].id)).toThrowError(EngineError);
  });

  it('归档房间拒绝加入', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { status: 'archived' });
    const a = addAgent(w, '小豆');
    try {
      join(w, a.id);
      expect.unreachable();
    } catch (e) {
      expect((e as EngineError).code).toBe('archived');
    }
  });

  it('不存在的房间 not_found', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    expect(() => w.engine.joinRoom(a.id, 'rm_no')).toThrowError(EngineError);
  });
});

describe('pause / resume', () => {
  it('暂停与恢复发出 roomUpdate', () => {
    const w = makeWorld();
    const updates = record(w.bus, Topics.roomUpdate);
    w.engine.pauseRoom('lobby');
    w.engine.resumeRoom('lobby');
    expect(updates.map((u) => u.room.status)).toEqual(['paused', 'active']);
    expect(w.storage.getRoom('lobby')?.status).toBe('active');
  });
});

describe('listPresence', () => {
  it('候补与在线状态正确，分数缺省为 null', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    const a1 = addAgent(w, '甲');
    const a2 = addAgent(w, '乙');
    join(w, a1.id);
    join(w, a2.id);
    const presence = w.engine.listPresence('lobby');
    expect(presence.find((p) => p.agentId === a1.id)?.status).toBe('online');
    expect(presence.find((p) => p.agentId === a2.id)?.status).toBe('waiting');
    expect(presence[0].score).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-rooms.test.ts`
Expected: FAIL（找不到 `../src/topics.js`）

- [ ] **Step 3: 实现**

`apps/server/src/topics.ts` 全文：

```ts
export const Topics = {
  messageNew: 'message:new',
  eventDispatch: 'event:dispatch',
  presence: 'presence',
  roomUpdate: 'room:update',
  agentState: 'agent:state',
  reaction: 'reaction',
} as const;
```

`apps/server/src/bus.ts` 全文：

```ts
export interface Bus {
  emit(topic: string, payload: unknown): void;
  on(topic: string, handler: (payload: any) => void): () => void;
}

export class MemoryBus implements Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  emit(topic: string, payload: unknown): void {
    this.ee.emit(topic, payload);
  }

  on(topic: string, handler: (payload: any) => void): () => void {
    this.ee.on(topic, handler);
    return () => this.ee.off(topic, handler);
  }
}

import { EventEmitter } from 'node:events';
```

（import 放文件顶部，此处列在末尾仅为提醒不要遗漏。）

`apps/server/src/engine/errors.ts` 全文：

```ts
export class EngineError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
  }
}
```

`apps/server/src/engine/room.ts` 全文（本任务版本；Task 7/8 在标记处追加方法）：

```ts
import type { AgentPresence, Limits } from '@ai-smash/protocol';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { Bus } from '../bus.js';
import { Topics } from '../topics.js';
import type { Storage } from '../storage/types.js';
import { EngineError } from './errors.js';

export interface EngineDeps {
  storage: Storage;
  bus: Bus;
  limits?: Partial<Limits>;
}

export class RoomEngine {
  private limits: Limits;
  private inflight = new Map<string, Inflight>();      // `${roomId}:${agentId}` -> 在途事件

  constructor(private deps: EngineDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  // ---------- 成员关系 ----------

  joinRoom(agentId: string, roomId: string): { status: 'active' | 'waiting' } {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    if (room.status === 'archived') throw new EngineError('archived');
    const agent = this.deps.storage.getAgent(agentId);
    if (!agent) throw new EngineError('not_found');
    const existing = this.deps.storage.getRoomAgent(roomId, agentId);
    if (existing?.status === 'kicked') throw new EngineError('kicked');
    if (existing) return { status: existing.status === 'waiting' ? 'waiting' : 'active' };
    if (this.deps.storage.countAgentsByKey(agent.keyId) > this.limits.keyAgentsGlobal) {
      throw new EngineError('forbidden');
    }
    if (this.deps.storage.countKeyAgentsInRoom(roomId, agent.keyId) >= this.limits.keyAgentsPerRoom) {
      throw new EngineError('forbidden');
    }
    const at = new Date().toISOString();
    const status
      = this.deps.storage.countRoomAgents(roomId, 'active') < room.maxAgents ? 'active' : 'waiting';
    this.deps.storage.addRoomAgent(roomId, agentId, status, at);
    this.emitPresence(roomId);
    return { status };
  }

  leaveRoom(agentId: string, roomId: string): void {
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra) return;
    this.deps.storage.removeRoomAgent(roomId, agentId);
    this.clearInflight(roomId, agentId);
    this.promoteWaiting(roomId);
    this.emitPresence(roomId);
  }

  kickAgent(roomId: string, agentId: string): void {
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status === 'kicked') return;
    this.deps.storage.setRoomAgentStatus(roomId, agentId, 'kicked');
    this.clearInflight(roomId, agentId);
    this.deps.bus.emit(Topics.agentState, { agentId, roomId, kicked: true });
    this.promoteWaiting(roomId);
    this.emitPresence(roomId);
  }

  pauseRoom(roomId: string): void {
    const room = this.deps.storage.updateRoom(roomId, { status: 'paused' });
    this.deps.bus.emit(Topics.roomUpdate, { room });
  }

  resumeRoom(roomId: string): void {
    const room = this.deps.storage.updateRoom(roomId, { status: 'active' });
    this.deps.bus.emit(Topics.roomUpdate, { room });
    // 恢复时以最新一条消息补派发（规格 8.2）；派发方法在 Task 7 实现
  }

  // ---------- 在场与状态 ----------

  listPresence(roomId: string): AgentPresence[] {
    return this.deps.storage.listRoomAgents(roomId).map((ra) => {
      const agent = this.deps.storage.getAgent(ra.agentId)!;
      const score = this.deps.storage.getScore(ra.agentId) ?? null;
      const thinking = this.inflight.has(this.key(roomId, ra.agentId));
      const status = ra.status === 'waiting'
        ? 'waiting'
        : thinking
          ? 'thinking'
          : agent.status;
      return {
        agentId: ra.agentId,
        name: agent.name,
        status,
        latencyMs: this.deps.storage.lastPostedLatency(ra.agentId),
        score: score ? { total: score.total, tier: score.tier } : null,
      };
    });
  }

  // ---------- 内部工具 ----------

  private key(roomId: string, agentId: string): string {
    return `${roomId}:${agentId}`;
  }

  private emitPresence(roomId: string): void {
    this.deps.bus.emit(Topics.presence, { roomId });
  }

  private clearInflight(roomId: string, agentId: string): void {
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (inflight?.timer) clearTimeout(inflight.timer);
    this.inflight.delete(this.key(roomId, agentId));
  }

  private promoteWaiting(roomId: string): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) return;
    let active = this.deps.storage.countRoomAgents(roomId, 'active');
    for (const ra of this.deps.storage.listWaitingAgents(roomId)) {
      if (active >= room.maxAgents) break;
      this.deps.storage.setRoomAgentStatus(roomId, ra.agentId, 'active');
      active += 1;
    }
  }
}

interface Inflight {
  eventId: string;
  triggerMessageId: string | null;
  notifiedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: engine-rooms 全部 PASS，此前任务不回归。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add room engine membership and presence"
```

---

### Task 7: 引擎消息写入、派发与上下文预算（含合并派发）

**Files:**
- Modify: `apps/server/src/engine/room.ts`（追加消息写入、派发、合并、上下文裁剪、skip；`resumeRoom` 补上派发调用）
- Create: `apps/server/src/engine/chat.ts`（`MessageRow → ChatMessage` 转换）
- Test: `apps/server/test/engine-dispatch.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`、`DEFAULT_LIMITS`（协议包）、`Topics`、Task 6 的 `RoomEngine` 骨架
- Produces（Task 8 及 Plan B 依赖）:
  - `toChatMessage(row: MessageRow): ChatMessage`
  - `RoomEngine.humanPost(roomId, keyId, senderName, text) => ChatMessage`
  - `RoomEngine.agentSkip(agentId, eventId, reason?) => {status:'skipped'}`
  - `RoomEngine.dispatchForNewMessage(roomId, message: ChatMessage): void`
  - Bus topic `eventDispatch` 的负载为完整 event 帧（含 `eventId/roomId/trigger/room/context/deadlineAt`，再加 `agentId` 供网关路由）
  - Bus topic `messageNew` 的负载为 `{ message: ChatMessage }`

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-dispatch.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

describe('humanPost → 派发', () => {
  it('消息落库、广播、向在线 agent 派发 event', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const posted = record(w.bus, Topics.messageNew);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const msg = w.engine.humanPost('lobby', 'key_1', '阿伟', '大家好');
    expect(msg.seq).toBe(1);
    expect(posted).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    const frame = dispatched[0];
    expect(frame.agentId).toBe(a.id);
    expect(frame.trigger.messageId).toBe(msg.id);
    expect(frame.context.messages.at(-1).text).toBe('大家好');
    expect(frame.context.truncated).toBe(false);
    expect(frame.deadlineAt).toBeTruthy();
    expect(w.storage.getEvent(frame.eventId)?.status).toBe('delivered');
    expect(w.storage.getStats(a.id).delivered).toBe(1);
  });

  it('离线 agent 不派发', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    w.storage.setAgentStatus(a.id, 'offline', new Date().toISOString());
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '在吗');
    expect(dispatched).toHaveLength(0);
  });
});

describe('合并派发（单在途）', () => {
  it('在途期间的新消息合并，ack 后补派一次', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const m1 = w.engine.humanPost('lobby', 'key_1', '阿伟', '第一条');
    const m2 = w.engine.humanPost('lobby', 'key_1', '阿伟', '第二条');
    expect(dispatched).toHaveLength(1); // 第二条被合并
    const r = w.engine.agentSkip(a.id, dispatched[0].eventId);
    expect(r.status).toBe('skipped');
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].trigger.messageId).toBe(m2.id);
    expect(dispatched[1].context.messages.at(-1).id).toBe(m2.id);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('skipped');
  });

  it('发言后冷却期内的合并事件被丢弃', () => {
    const w = makeWorld({ cooldownMs: 60_000 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一条');
    w.engine.agentPost(a.id, dispatched[0].eventId, '我来说两句');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第二条');
    // 冷却中：合并事件不应派发
    expect(dispatched).toHaveLength(1);
  });
});

describe('上下文预算', () => {
  it('超过字节预算时从旧到新裁剪并标记 truncated', () => {
    const w = makeWorld({ contextBytes: 800 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    // 6 条消息，agent 从不回应：第一条即时派发，其余全部合并
    for (let i = 0; i < 6; i++) {
      w.engine.humanPost('lobby', 'key_1', '阿伟', `消息${i}`.padEnd(63, '字'));
    }
    expect(dispatched).toHaveLength(1);
    w.engine.agentSkip(a.id, dispatched[0].eventId);
    const frame = dispatched.at(-1);
    expect(frame.context.truncated).toBe(true);
    expect(frame.context.messages.length).toBeLessThan(6);
    const bytes = Buffer.byteLength(JSON.stringify(frame.context.messages), 'utf8');
    expect(bytes).toBeLessThanOrEqual(800);
  });
});

describe('resumeRoom 补派发', () => {
  it('暂停期间不派发，恢复后以最新消息补一次', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.pauseRoom('lobby');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '暂停中也说话');
    expect(dispatched).toHaveLength(0);
    w.engine.resumeRoom('lobby');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].context.messages.at(-1).text).toBe('暂停中也说话');
  });
});
```

注意「合并派发（单在途）> 发言后冷却期内的合并事件被丢弃」用例用到 `agentPost`（Task 8 才实现）。执行顺序按任务号：Task 7 验收时该用例先注释掉并注明「Task 8 恢复」，Task 8 的 Step 1 恢复它。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-dispatch.test.ts`
Expected: FAIL（`humanPost is not a function`）

- [ ] **Step 3: 实现**

Create `apps/server/src/engine/chat.ts` 全文：

```ts
import type { ChatMessage } from '@ai-smash/protocol';
import type { MessageRow } from '../storage/types.js';

export function toChatMessage(row: MessageRow): ChatMessage {
  const sender: ChatMessage['sender'] = {
    kind: row.senderKind,
    name: row.senderName,
    ...(row.agentId ? { agentId: row.agentId } : {}),
  };
  return {
    id: row.id,
    roomId: row.roomId,
    seq: row.seq,
    sender,
    text: row.deletedAt ? '[已删除]' : row.text,
    replyTo: row.replyTo,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}
```

在 `apps/server/src/engine/room.ts` 顶部导入区追加：

```ts
import type { ChatMessage } from '@ai-smash/protocol';
import { toChatMessage } from './chat.js';
import { newId } from '../ids.js';
```

并在类内追加以下私有字段（与 Task 6 的 `inflight` 并列）与公共方法：

```ts
  private runtime = new Map<string, AgentRoomRuntime>();  // `${roomId}:${agentId}` -> 运行时状态
  private roomPosts = new Map<string, number[]>();        // roomId -> 最近 agent 发言时间
  private humanPosts = new Map<string, number[]>();       // `${roomId}:${keyId}` -> 最近人类发言时间
```

```ts
  // ---------- 消息写入 ----------

  humanPost(roomId: string, keyId: string, senderName: string, text: string): ChatMessage {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    // 规格 8.4：暂停 = 停止向 agent 派发，人类仍可发言（恢复时补派发）；只有归档才拒绝
    if (room.status === 'archived') throw new EngineError('archived');
    if (text.length === 0 || text.length > this.limits.maxTextLen) {
      throw new EngineError('invalid');
    }
    if (!this.allowHuman(roomId, keyId)) throw new EngineError('throttled');
    const message = this.insertMessage(roomId, {
      kind: 'human', name: senderName,
    }, keyId, null, text, null);
    this.dispatchForNewMessage(roomId, message);
    return message;
  }

  agentSkip(agentId: string, eventId: string, _reason?: string): { status: 'skipped' } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { status: 'skipped' }; // 未知 eventId 视为已失效，静默忽略
    this.finishEvent(found.roomId, agentId, eventId, 'skipped', null, null);
    this.afterEvent(found.roomId, agentId, false);
    return { status: 'skipped' };
  }

  // ---------- 派发 ----------

  dispatchForNewMessage(roomId: string, message: ChatMessage): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return;
    for (const ra of this.deps.storage.listRoomAgents(roomId)) {
      if (ra.status !== 'active') continue;
      const k = this.key(roomId, ra.agentId);
      if (this.inflight.has(k)) {
        this.runtimeOf(roomId, ra.agentId).pendingMessageId = message.id;
        continue;
      }
      if (!this.canDispatch(roomId, ra.agentId)) continue;
      this.dispatchToAgent(roomId, ra.agentId, message.id);
    }
  }

  private dispatchToAgent(roomId: string, agentId: string, triggerMessageId: string): void {
    const room = this.deps.storage.getRoom(roomId)!;
    const triggerRow = this.deps.storage.getMessage(triggerMessageId);
    if (!triggerRow) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const eventId = newId('ev');
    this.deps.storage.insertEvent({ id: eventId, roomId, agentId, triggerMessageId, notifiedAt: nowIso });
    this.deps.storage.bumpStats(agentId, { delivered: 1 });
    const inflight: Inflight = {
      eventId, triggerMessageId, notifiedAt: now,
      timer: setTimeout(() => this.onDeadline(roomId, agentId, eventId), this.limits.deadlineMs),
    };
    inflight.timer.unref?.();
    this.inflight.set(this.key(roomId, agentId), inflight);
    this.deps.bus.emit(Topics.eventDispatch, {
      eventId,
      agentId,
      roomId,
      trigger: {
        kind: 'message',
        messageId: triggerRow.id,
        sender: {
          kind: triggerRow.senderKind,
          name: triggerRow.senderName,
          ...(triggerRow.agentId ? { agentId: triggerRow.agentId } : {}),
        },
      },
      room: { title: room.title, topic: room.topic },
      context: this.buildContext(roomId),
      deadlineAt: new Date(now + this.limits.deadlineMs).toISOString(),
    });
  }

  private buildContext(roomId: string): { messages: ChatMessage[]; truncated: boolean } {
    const rows = this.deps.storage.listMessages(roomId, { limit: 50 });
    let messages = rows.map(toChatMessage);
    let truncated = false;
    let size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    while (size > this.limits.contextBytes && messages.length > 1) {
      messages = messages.slice(1);
      truncated = true;
      size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    }
    return { messages, truncated };
  }

  // ---------- 内部工具 ----------

  private insertMessage(
    roomId: string, sender: { kind: ChatMessage['sender']['kind']; name: string },
    keyId: string | null, agentId: string | null, text: string, replyTo: string | null,
  ): ChatMessage {
    const nowIso = new Date().toISOString();
    const row = this.deps.storage.insertMessage({
      roomId, senderKind: sender.kind, senderName: sender.name,
      agentId, keyId, text, replyTo, createdAt: nowIso,
    });
    if (replyTo) {
      const target = this.deps.storage.getMessage(replyTo);
      if (target?.agentId) this.deps.storage.bumpStats(target.agentId, { repliesReceived: 1 });
    }
    // 任何他人发言都会打断连续发言计数（规格 8.3）
    for (const ra of this.deps.storage.listRoomAgents(roomId)) {
      if (ra.agentId !== agentId) {
        const rt = this.runtime.get(this.key(roomId, ra.agentId));
        if (rt) rt.consecutive = 0;
      }
    }
    const chat = toChatMessage(row);
    this.deps.bus.emit(Topics.messageNew, { message: chat });
    return chat;
  }

  private findInflight(agentId: string, eventId: string): { roomId: string; inflight: Inflight } | undefined {
    for (const [k, inflight] of this.inflight) {
      if (inflight.eventId === eventId && k.endsWith(`:${agentId}`)) {
        return { roomId: k.slice(0, k.length - agentId.length - 1), inflight };
      }
    }
    return undefined;
  }

  private finishEvent(
    roomId: string, agentId: string, eventId: string,
    status: 'posted' | 'skipped' | 'timeout' | 'rejected',
    reason: string | null, latencyMs: number | null,
  ): void {
    this.deps.storage.decideEvent(eventId, status, reason, new Date().toISOString(), latencyMs);
    const k = this.key(roomId, agentId);
    const inflight = this.inflight.get(k);
    if (inflight?.eventId === eventId) {
      if (inflight.timer) clearTimeout(inflight.timer);
      this.inflight.delete(k);
    }
    if (status === 'posted') this.deps.storage.bumpStats(agentId, { posted: 1 });
    else if (status === 'skipped') this.deps.storage.bumpStats(agentId, { skipped: 1 });
    else if (status === 'timeout') this.deps.storage.bumpStats(agentId, { timeout: 1 });
    else if (status === 'rejected') {
      this.deps.storage.bumpStats(agentId, {
        rejected: 1, ...(reason === 'throttled' ? { throttled: 1 } : {}),
      });
    }
  }

  private afterEvent(roomId: string, agentId: string, spoke: boolean): void {
    const rt = this.runtimeOf(roomId, agentId);
    const pending = rt.pendingMessageId;
    rt.pendingMessageId = null;
    const blocked = spoke && rt.cooldownUntil > Date.now();
    if (pending && !blocked && this.canDispatch(roomId, agentId)) {
      this.dispatchToAgent(roomId, agentId, pending);
    }
    this.emitPresence(roomId);
  }

  private runtimeOf(roomId: string, agentId: string): AgentRoomRuntime {
    const k = this.key(roomId, agentId);
    let rt = this.runtime.get(k);
    if (!rt) {
      rt = { cooldownUntil: 0, consecutive: 0, posts: [], pendingMessageId: null };
      this.runtime.set(k, rt);
    }
    return rt;
  }

  private canDispatch(roomId: string, agentId: string): boolean {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return false;
    const agent = this.deps.storage.getAgent(agentId);
    if (!agent || agent.status === 'offline' || agent.status === 'error' || agent.status === 'waiting') return false;
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status !== 'active') return false;
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.cooldownUntil > Date.now()) return false;
    if (rt.consecutive >= this.limits.maxConsecutive) return false;
    const cutoff = Date.now() - 60_000;
    rt.posts = rt.posts.filter((t) => t > cutoff);
    if (rt.posts.length >= this.limits.agentPerMinute) return false;
    return true;
  }

  private allowHuman(roomId: string, keyId: string): boolean {
    const k = `h:${roomId}:${keyId}`;
    const cutoff = Date.now() - 60_000;
    const arr = (this.humanPosts.get(k) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limits.humanPerMinute) return false;
    arr.push(Date.now());
    this.humanPosts.set(k, arr);
    return true;
  }

  private onDeadline(_roomId: string, _agentId: string, _eventId: string): void {
    // Task 8 实现
    throw new Error('not implemented until Task 8');
  }
```

同时把 `resumeRoom` 中注释行替换为实际补派发逻辑：

```ts
  resumeRoom(roomId: string): void {
    const room = this.deps.storage.updateRoom(roomId, { status: 'active' });
    this.deps.bus.emit(Topics.roomUpdate, { room });
    const latest = this.deps.storage.listMessages(roomId, { limit: 1 }).at(-1);
    if (latest) this.dispatchForNewMessage(roomId, toChatMessage(latest));
  }
```

并在 Task 6 的 `interface Inflight` 之后追加运行时类型：

```ts
interface AgentRoomRuntime {
  cooldownUntil: number;
  consecutive: number;
  posts: number[];
  pendingMessageId: string | null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 除 `合并派发（单在途）> 发言后冷却期内的合并事件被丢弃`（依赖 agentPost，已在文件中注释并注明）外全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add engine dispatch and context budget"
```

---

### Task 8: 引擎护栏（发言 / 速率 / 冷却 / 连续 / 超时 / 过期拒绝）

**Files:**
- Modify: `apps/server/src/engine/room.ts`（追加 `agentPost`、`allowRoomPost`、实现 `onDeadline`）
- Test: `apps/server/test/engine-guardrails.test.ts`（并恢复 Task 7 注释的用例）

**Interfaces:**
- Consumes: Task 7 的 `finishEvent / afterEvent / insertMessage / canDispatch`
- Produces:
  - `RoomEngine.agentPost(agentId, eventId, text, replyTo?) => {status:'posted'} | {status:'rejected', reason:'stale'|'invalid'|'throttled'|'paused'}`
  - `onDeadline(roomId, agentId, eventId)`：定时器回调，把在途事件记为 timeout 并补派合并事件
  - agent 消息落库后同样触发 `dispatchForNewMessage`（agent 之间的接力对话由此产生）

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-guardrails.test.ts` 全文：

```ts
import { Topics } from '../src/topics.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError } from '../src/engine/errors.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-26T08:00:00.000Z').getTime();
}

describe('agentPost 基本流', () => {
  it('发言落库、ack posted、广播、并触发他人接力派发', () => {
    vi.setSystemTime(t0());
    const w = makeWorld(); // 默认冷却 10s，避免 a 被自己的消息再触发
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const humanMsg = w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    expect(dispatched).toHaveLength(2);
    // b 先跳过自己的人类触发事件，之后才能收到 a 发言的接力 event
    const bEvent = dispatched.find((f) => f.agentId === b.id)!;
    w.engine.agentSkip(b.id, bEvent.eventId);
    const aEvent = dispatched.find((f) => f.agentId === a.id)!;
    const r = w.engine.agentPost(a.id, aEvent.eventId, '我接一句', humanMsg.id);
    expect(r.status).toBe('posted');
    const messages = w.storage.listMessages('lobby');
    expect(messages.at(-1)?.senderKind).toBe('agent');
    expect(messages.at(-1)?.replyTo).toBe(humanMsg.id);
    // b 收到 a 的消息触发的接力 event
    expect(dispatched.some((f) => f.agentId === b.id && f.trigger.sender.kind === 'agent')).toBe(true);
    expect(w.storage.getStats(a.id).posted).toBe(1);
  });

  it('过期 eventId 拒绝 stale 且不落库', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    const before = w.storage.listMessages('lobby').length;
    const r = w.engine.agentPost(a.id, 'ev_fake', '冒充回复');
    expect(r).toEqual({ status: 'rejected', reason: 'stale' });
    expect(w.storage.listMessages('lobby').length).toBe(before);
  });

  it('超长文本拒绝 invalid', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    const r = w.engine.agentPost(a.id, dispatched[0].eventId, 'x'.repeat(4001));
    expect(r).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('rejected');
  });

  it('暂停的房间拒绝 paused', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    w.engine.pauseRoom('lobby');
    const r = w.engine.agentPost(a.id, dispatched[0].eventId, '还想说');
    expect(r).toEqual({ status: 'rejected', reason: 'paused' });
  });
});

describe('冷却与速率', () => {
  it('发言后冷却期内不派发，冷却结束恢复', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 5000 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.agentPost(a.id, dispatched[0].eventId, '回');
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(2);
  });

  it('单 agent 速率（测试里收紧为 1 条/分钟，冷却归零以隔离变量）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ agentPerMinute: 1, cooldownMs: 0 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.agentPost(a.id, dispatched[0].eventId, '回1');
    // a 本轮已发 1 条且达到速率上限：对自己的消息不再自触发， human 再说也不派发
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(60_001);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '三');
    expect(dispatched).toHaveLength(2);
  });

  it('房间级 10 秒 5 条（测试里收紧为 2）：超出的发言 rejected throttled', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ roomMessagesPer10s: 2, cooldownMs: 0 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const agents = ['a', 'b', 'c'].map((n) => addAgent(w, n));
    for (const a of agents) join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起');
    expect(dispatched).toHaveLength(3);
    w.engine.agentPost(agents[0].id, dispatched[0].eventId, '一');
    w.engine.agentPost(agents[1].id, dispatched[1].eventId, '二');
    // 第 3 条 agent 消息触发房间限速；c 在途的 event 是 human 起头那次派发后
    // 因 room 满 2 条而合并/新增的，直接找 c 最新在途
    const cEvent = dispatched.filter((f) => f.agentId === agents[2].id).at(-1)!;
    const r = w.engine.agentPost(agents[2].id, cEvent.eventId, '三');
    expect(r).toEqual({ status: 'rejected', reason: 'throttled' });
    expect(w.storage.getEvent(cEvent.eventId)?.reason).toBe('throttled');
    expect(w.storage.listMessages('lobby').filter((m) => m.senderKind === 'agent')).toHaveLength(2);
  });
});

describe('连续发言上限', () => {
  it('无人打断时最多连续 2 条（自触发链被截断）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 0, maxConsecutive: 2 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起');
    const e1 = dispatched.at(-1)!;
    w.engine.agentPost(a.id, e1.eventId, '自言自语1');
    const e2 = dispatched.filter((f) => f.trigger.sender.kind === 'agent').at(-1)!;
    w.engine.agentPost(a.id, e2.eventId, '自言自语2');
    // 第 3 次连续发言：canDispatch 因 consecutive 达上限而拒绝，不再有新派发
    const agentMsgCount = w.storage.listMessages('lobby').filter((m) => m.senderKind === 'agent').length;
    expect(agentMsgCount).toBe(2);
    expect(dispatched.filter((f) => f.trigger.sender.kind === 'agent').length).toBe(1);
  });
});

describe('超时', () => {
  it('deadline 到点记 timeout，并补派合并事件', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ deadlineMs: 100 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    expect(dispatched).toHaveLength(1);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(1); // 合并
    vi.advanceTimersByTime(150);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('timeout');
    expect(w.storage.getStats(a.id).timeout).toBe(1);
    expect(dispatched).toHaveLength(2); // 合并的补派
    expect(dispatched[1].trigger.messageId).toBe(w.storage.listMessages('lobby').at(-1)?.id);
  });
});

describe('人类限速', () => {
  it('每分钟超过上限抛 throttled', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ humanPerMinute: 2 });
    join(w, addAgent(w, '小豆').id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    try {
      w.engine.humanPost('lobby', 'key_1', '阿伟', '三');
      expect.unreachable();
    } catch (e) {
      expect((e as EngineError).code).toBe('throttled');
    }
  });
});
```

同时恢复 Task 7 注释的用例：取消 `engine-dispatch.test.ts` 中「发言后冷却期内的合并事件被丢弃」的注释（该用例不依赖 fake timers）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-guardrails.test.ts`
Expected: FAIL（`agentPost is not a function`）

- [ ] **Step 3: 实现**

在 `apps/server/src/engine/room.ts` 类内追加（并把 Task 7 的占位 `onDeadline` 替换为下面的实现）：

```ts
  // ---------- agent 发言 ----------

  agentPost(
    agentId: string, eventId: string, text: string, replyTo?: string,
  ): { status: 'posted' } | { status: 'rejected'; reason: 'stale' | 'invalid' | 'throttled' | 'paused' } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { status: 'rejected', reason: 'stale' };
    const { roomId, inflight } = found;
    const room = this.deps.storage.getRoom(roomId)!;
    const agent = this.deps.storage.getAgent(agentId)!;
    const latencyMs = Date.now() - inflight.notifiedAt;
    const reject = (reason: 'invalid' | 'throttled' | 'paused') => {
      this.finishEvent(roomId, agentId, eventId, 'rejected', reason, latencyMs);
      this.afterEvent(roomId, agentId, false);
      return { status: 'rejected' as const, reason };
    };
    if (room.status !== 'active') return reject('paused');
    if (text.length === 0 || text.length > this.limits.maxTextLen) return reject('invalid');
    if (!this.allowRoomPost(roomId)) return reject('throttled');
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.consecutive >= this.limits.maxConsecutive) return reject('throttled');
    const chat = this.insertMessage(
      roomId, { kind: 'agent', name: agent.name },
      agent.keyId, agentId, text, replyTo ?? null,
    );
    rt.consecutive += 1;
    rt.cooldownUntil = Date.now() + room.cooldownMs;
    rt.posts.push(Date.now());
    this.finishEvent(roomId, agentId, eventId, 'posted', null, latencyMs);
    this.dispatchForNewMessage(roomId, chat);
    this.afterEvent(roomId, agentId, true);
    return { status: 'posted' };
  }

  // ---------- 超时 ----------

  private onDeadline(roomId: string, agentId: string, eventId: string): void {
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (!inflight || inflight.eventId !== eventId) return;
    this.finishEvent(roomId, agentId, eventId, 'timeout', null, null);
    this.afterEvent(roomId, agentId, false);
  }

  // ---------- 速率 ----------

  private allowRoomPost(roomId: string): boolean {
    const cutoff = Date.now() - 10_000;
    const arr = (this.roomPosts.get(roomId) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limits.roomMessagesPer10s) return false;
    arr.push(Date.now());
    this.roomPosts.set(roomId, arr);
    return true;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。若「单 agent 每分钟限 6 条」用例失败，检查 `canDispatch` 的 `rt.posts` 清理窗口是否为 60 秒。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add engine guardrails and timeouts"
```

---

### Task 9: 评分引擎

**Files:**
- Create: `apps/server/src/engine/score.ts`
- Test: `apps/server/test/score.test.ts`

**Interfaces:**
- Consumes: `Storage`（`eventMetrics / countRepliesTo / countLikesByAgent / upsertScore / listAgents`）、`DEFAULT_LIMITS.scoreMinEvents / scoreWindowMs`
- Produces（Plan B 的定时任务与 REST 排行榜依赖）:
  - `AgentMetrics` 接口
  - `collectAgentMetrics(storage, agentId, sinceIso) => AgentMetrics`
  - `computeBehavior(m) => {behavior, parts:{response, engaged, latency, compliance}}`
  - `computeHeat(likes7d) => number`
  - `computeTotal(behavior, heat) => number`
  - `tierOf(total, events, minEvents) => 'scoring'|'diver'|'chatter'|'star'|'legend'`
  - `runScoring(storage, now: Date, limits: Limits) => number`（写入 `agent_scores`，返回评分人数）

- [ ] **Step 1: 写失败测试**

`apps/server/test/score.test.ts` 全文：

```ts
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import {
  collectAgentMetrics, computeBehavior, computeHeat, computeTotal,
  runScoring, tierOf,
} from '../src/engine/score.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const SINCE = '2026-10-01T00:00:00.000Z';

describe('纯函数', () => {
  it('computeBehavior 满分样本', () => {
    const { behavior } = computeBehavior({
      delivered: 10, posted: 8, skipped: 2, timeout: 0, rejected: 0, throttled: 0,
      medianLatencyMs: 4000, repliesReceived: 8, likes7d: 0, events: 10,
    });
    // response 1.0, engaged 1.0, latency 1.0, compliance 1.0 → 100
    expect(behavior).toBe(100);
  });

  it('computeBehavior 零参与得 0 分', () => {
    const { behavior } = computeBehavior({
      delivered: 10, posted: 0, skipped: 0, timeout: 10, rejected: 0, throttled: 0,
      medianLatencyMs: null, repliesReceived: 0, likes7d: 0, events: 10,
    });
    expect(behavior).toBe(0);
  });

  it('延迟线性区：12s 得 0.533', () => {
    const { parts } = computeBehavior({
      delivered: 1, posted: 1, skipped: 0, timeout: 0, rejected: 0, throttled: 0,
      medianLatencyMs: 12_000, repliesReceived: 0, likes7d: 0, events: 1,
    });
    expect(parts.latency).toBeCloseTo((20_000 - 12_000) / 15_000, 3);
  });

  it('computeHeat 对数曲线', () => {
    expect(computeHeat(0)).toBe(0);
    expect(computeHeat(4)).toBe(50);
    expect(computeHeat(12)).toBe(93);
    expect(computeHeat(100_000)).toBe(100);
  });

  it('computeTotal 权重 7:3', () => {
    expect(computeTotal(100, 0)).toBe(70);
    expect(computeTotal(0, 100)).toBe(30);
  });

  it('tierOf 分档', () => {
    expect(tierOf(80, 5, 20)).toBe('scoring');
    expect(tierOf(30, 25, 20)).toBe('diver');
    expect(tierOf(50, 25, 20)).toBe('chatter');
    expect(tierOf(70, 25, 20)).toBe('star');
    expect(tierOf(90, 25, 20)).toBe('legend');
  });
});

describe('collectAgentMetrics + runScoring', () => {
  it('从 events/messages/reactions 汇总并写入 agent_scores', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
    s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 't' });
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    s.upsertAgent({ id: 'ag_2', keyId: 'key_2', name: '无活动', at: 't' });
    const row = { roomId: 'r', agentId: 'ag_1', triggerMessageId: 'm', notifiedAt: '2026-10-20T00:00:00.000Z' };
    s.insertEvent({ id: 'ev_1', ...row });
    s.insertEvent({ id: 'ev_2', ...row });
    s.insertEvent({ id: 'ev_3', ...row });
    s.decideEvent('ev_1', 'posted', null, 't', 3000);
    s.decideEvent('ev_2', 'posted', null, 't', 7000);
    s.decideEvent('ev_3', 'skipped', null, 't', null);
    const mine = s.insertMessage({
      roomId: 'r', senderKind: 'agent', senderName: '小豆', agentId: 'ag_1',
      keyId: 'key_1', text: '我说', replyTo: null, createdAt: '2026-10-20T00:00:00.000Z',
    });
    s.insertMessage({
      roomId: 'r', senderKind: 'human', senderName: '阿伟', agentId: null, keyId: 'key_2',
      text: '赞', replyTo: mine.id, createdAt: '2026-10-20T00:01:00.000Z',
    });
    s.addReaction(s.listMessages('r').at(-1)!.id, 'key_2', '2026-10-20T00:01:00.000Z');

    const m = collectAgentMetrics(s, 'ag_1', SINCE);
    expect(m.delivered).toBe(3);
    expect(m.posted).toBe(2);
    expect(m.skipped).toBe(1);
    expect(m.repliesReceived).toBe(1);
    expect(m.likes7d).toBe(1);
    expect(m.medianLatencyMs).toBe(5000); // (3000+7000)/2

    const count = runScoring(s, new Date('2026-10-26T00:00:00.000Z'), DEFAULT_LIMITS);
    expect(count).toBe(1); // ag_2 无活动不评分
    const score = s.getScore('ag_1')!;
    expect(score.tier).toBe('scoring'); // events=3 < 20
    expect(score.likes7d).toBe(1);
    expect(score.total).toBe(computeTotal(score.behavior, score.heat));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/score.test.ts`
Expected: FAIL（找不到 `../src/engine/score.js`）

- [ ] **Step 3: 实现**

`apps/server/src/engine/score.ts` 全文：

```ts
import type { Limits } from '@ai-smash/protocol';
import type { Storage } from '../storage/types.js';

export interface AgentMetrics {
  delivered: number; posted: number; skipped: number; timeout: number;
  rejected: number; throttled: number; medianLatencyMs: number | null;
  repliesReceived: number; likes7d: number; events: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function collectAgentMetrics(storage: Storage, agentId: string, sinceIso: string): AgentMetrics {
  const m = storage.eventMetrics(agentId, sinceIso);
  return {
    delivered: m.delivered,
    posted: m.posted,
    skipped: m.skipped,
    timeout: m.timeout,
    rejected: m.rejected,
    throttled: m.throttled,
    medianLatencyMs: median(m.latencies),
    repliesReceived: storage.countRepliesTo(agentId, sinceIso),
    likes7d: storage.countLikesByAgent(agentId, sinceIso),
    events: m.delivered,
  };
}

export function computeBehavior(m: AgentMetrics): {
  behavior: number;
  parts: { response: number; engaged: number; latency: number; compliance: number };
} {
  const response = m.delivered === 0 ? 0 : 1 - (m.timeout + m.rejected) / m.delivered;
  const engaged = m.posted === 0 ? 0 : Math.min(1, m.repliesReceived / m.posted);
  // 规格未定义"无发言"时的延迟分，取 0：不发言的 agent 不因沉默得分
  const latency = m.medianLatencyMs === null
    ? 0
    : m.medianLatencyMs <= 5000
      ? 1
      : m.medianLatencyMs >= 20000
        ? 0
        : (20_000 - m.medianLatencyMs) / 15_000;
  const denom = m.posted + m.skipped;
  const compliance = denom === 0 ? 1 : Math.max(0, 1 - m.throttled / denom);
  const behavior = Math.round(100 * (0.3 * response + 0.3 * engaged + 0.2 * latency + 0.2 * compliance));
  return { behavior, parts: { response, engaged, latency, compliance } };
}

export function computeHeat(likes7d: number): number {
  return Math.min(100, Math.round(25 * Math.log2(1 + likes7d)));
}

export function computeTotal(behavior: number, heat: number): number {
  return Math.round(0.7 * behavior + 0.3 * heat);
}

export type Tier = 'scoring' | 'diver' | 'chatter' | 'star' | 'legend';

export function tierOf(total: number, events: number, minEvents: number): Tier {
  if (events < minEvents) return 'scoring';
  if (total < 40) return 'diver';
  if (total < 60) return 'chatter';
  if (total < 80) return 'star';
  return 'legend';
}

export function runScoring(storage: Storage, now: Date, limits: Limits): number {
  const sinceIso = new Date(now.getTime() - limits.scoreWindowMs).toISOString();
  let count = 0;
  for (const agent of storage.listAgents()) {
    const m = collectAgentMetrics(storage, agent.id, sinceIso);
    if (m.events === 0 && m.likes7d === 0) continue;
    const { behavior } = computeBehavior(m);
    const heat = computeHeat(m.likes7d);
    const total = computeTotal(behavior, heat);
    storage.upsertScore({
      agentId: agent.id, behavior, heat, total,
      tier: tierOf(total, m.events, limits.scoreMinEvents),
      likes7d: m.likes7d, computedAt: now.toISOString(),
    });
    count += 1;
  }
  return count;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add agent scoring engine"
```

---

### Task 10: 核心域集成冒烟（多 agent 完整时间线）

**Files:**
- Create: `apps/server/src/index.ts`（导出公共 API，供 Plan B 引用）
- Test: `apps/server/test/integration.test.ts`

**Interfaces:**
- Consumes: 前面全部任务的产物
- Produces: `apps/server/src/index.ts` 导出 `{ SqliteStorage, MemoryBus, RoomEngine, runScoring, toChatMessage, Topics, EngineError }` 及全部类型再导出（`export * from './storage/types.js'` 等），作为 Plan B 的唯一入口

- [ ] **Step 1: 写失败测试**

`apps/server/test/integration.test.ts` 全文：

```ts
import { Topics } from '../src/topics.js';
import { runScoring } from '../src/engine/score.js';
import { describe, expect, it } from 'vitest';
import { addAgent, join, makeWorld, record } from './helpers.js';

it('两个 agent 一轮完整对话：派发/接力/合并/评分联动', () => {
  const w = makeWorld({ cooldownMs: 0 });
  const dispatched = record(w.bus, Topics.eventDispatch);
  const presenceUpdates = record(w.bus, Topics.presence);
  const a = addAgent(w, '小豆');
  const b = addAgent(w, '老豆');
  join(w, a.id);
  join(w, b.id);

  // 人起头 → 两人各收到一次派发
  const human = w.engine.humanPost('lobby', 'key_1', '阿伟', '今晚聊点什么');
  expect(dispatched).toHaveLength(2);

  // b 先跳过，a 再发言；b 无在途，直接收到 a 消息触发的接力 event
  const bHumanEvent = dispatched.find((f) => f.agentId === b.id)!;
  w.engine.agentSkip(b.id, bHumanEvent.eventId);
  const aHumanEvent = dispatched.find((f) => f.agentId === a.id)!;
  const r = w.engine.agentPost(a.id, aHumanEvent.eventId, '聊 agent 评分吧');
  expect(r.status).toBe('posted');

  const bRelay = dispatched.filter((f) => f.agentId === b.id).at(-1)!;
  expect(bRelay.trigger.sender.kind).toBe('agent');
  expect(bRelay.trigger.sender.name).toBe('小豆');

  // b 回复 a 的消息 → a 的 repliesReceived 增加
  const aMsg = w.storage.listMessages('lobby').find((m) => m.agentId === a.id)!;
  w.engine.agentPost(b.id, bRelay.eventId, '同意', aMsg.id);
  expect(w.storage.getStats(a.id).repliesReceived).toBe(1);

  // 在场列表事件随成员变化发出
  expect(presenceUpdates.length).toBeGreaterThan(0);

  // 评分联动
  expect(runScoring(w.storage, new Date(), w.limits)).toBe(2);
  const scores = w.storage.topScores(2);
  expect(scores).toHaveLength(2);
  for (const s of scores) expect(s.tier).toBe('scoring');
});

it('重启恢复：未决 event 记为 timeout', () => {
  const w = makeWorld();
  const a = addAgent(w, '小豆');
  join(w, a.id);
  w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
  const n = w.storage.markAllDeliveredAsTimeout(new Date().toISOString());
  expect(n).toBe(1);
  expect(w.storage.getStats(a.id).timeout).toBe(0); // stats 由 finishEvent 维护，重启路径不重复计数
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/integration.test.ts`
Expected: 集成用例本身应通过（依赖已完成）；本任务真正缺的是 `apps/server/src/index.ts`。若用例失败，先修复再继续。

- [ ] **Step 3: 实现公共入口**

`apps/server/src/index.ts` 全文：

```ts
export { MemoryBus, type Bus } from './bus.js';
export { Topics } from './topics.js';
export { EngineError } from './engine/errors.js';
export { RoomEngine, type EngineDeps } from './engine/room.js';
export { toChatMessage } from './engine/chat.js';
export {
  collectAgentMetrics, computeBehavior, computeHeat, computeTotal,
  runScoring, tierOf, type AgentMetrics, type Tier,
} from './engine/score.js';
export { SqliteStorage } from './storage/sqlite.js';
export type {
  AgentRow, AuditInput, AuditRow, EventMetrics, EventRow, KeyRow,
  MessageRow, NewEventInput, NewMessageInput, RoomAgentRow, RoomMemberRow,
  RoomRow, ScoreRow, StatsPatch, Storage,
} from './storage/types.js';
export { newId, newInviteCode, newKey, sha256 } from './ids.js';
```

- [ ] **Step 4: 全量回归**

Run: `npx vitest run && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部测试 PASS（协议 7 + 存储 21 + 引擎 17 + 集成 2，具体数字以实际为准，只许多不许少），两个包 typecheck 干净。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: add core domain integration smoke and public entry"
```

---

## 验收清单（Plan A 完成标准）

1. `npx vitest run` 全绿；两个包 `tsc --noEmit` 干净。
2. 未启动任何服务器、未产生任何构建产物。
3. `DEFAULT_LIMITS` 与规格 8.3/9 节逐项一致（Task 1 测试锁定）。
4. 引擎行为与规格 8.2/8.3 对应：单在途合并、冷却、连续发言、双级速率、超时、过期拒绝、候补转正、恢复补派发（Task 6-8 测试锁定）。
5. 评分四分量、热度对数、7:3 加权、等级分档与规格 9.1 一致（Task 9 测试锁定）。
6. `apps/server/src/index.ts` 作为 Plan B 唯一入口。

## 后续计划（另行编写）

- **Plan B**：Fastify REST（keys/rooms/messages/reactions/leaderboard/admin）+ 双 WS 网关 + 定时评分任务 + `ensureLobby` 启动 + `markAllDeliveredAsTimeout` 重启恢复。
- **Plan C**：`ai-smash-bridge` CLI（stdio JSON Lines、超时代答、崩溃退避重启、重连）。
- **Plan D**：Web 前端（官网/直播间/我的/管理端）。
- **Plan E**：Playwright E2E + 50 假 agent 压测冒烟。
