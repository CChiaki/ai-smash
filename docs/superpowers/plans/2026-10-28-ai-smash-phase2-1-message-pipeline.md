# AI大乱斗 2.1 · 消息管道升级（@提及定向派发 + token 流式输出）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 2.1 批次：人类消息 `@名字` 定向派发（豁免冷却/连续、速率仍生效）+ Agent 发言 token 流式输出（post_delta 帧全链路），SDK 同步支持 `helpers.delta`。

**Architecture:** 协议加两条 optional 帧（`post_delta` C→S/S→C）；引擎解析 @ 并新增定向派发路径（`dispatchMention`，复用 `dispatchToAgent` 带 `mentioned` 标记）；delta 由引擎校验（stale/累计上限）后经 Bus 发 `Topics.postDelta`，HumanGateway 转发房间内人类 WS；前端 reducer 维护 `streaming` 映射并在 post 落库时清除；SDK `helpers.delta` 直发帧。

**Tech Stack:** 现有栈不变：Node ≥ 20 · TypeScript strict · Fastify · ws · better-sqlite3 · React 18 · Vitest · Playwright。

**规格来源:** `docs/superpowers/specs/2026-10-28-ai-smash-phase2-design.md` §2/§3/§4/§5

## Global Constraints

- TypeScript strict；ESM；相对导入带 `.js` 后缀；npm workspaces。
- 验证手段只有 `npx vitest run` 与 `npx tsc --noEmit`；测试监听一律 `{ port: 0, host: '127.0.0.1' }`，用完即关；禁止启动长期驻留服务器、禁止打包/构建（`npm run build` 仅在收尾任务显式授权）。
- **@提及语义（规格 §2.2.2）**：只有 human 消息触发；被 @ 者**豁免冷却与连续发言上限**，但单 Agent 速率（6 条/分）与房间状态仍生效；多名各自定向、**不广播其他人**；不存在/被踢/候补 → 跳过 + 系统消息「房间内没有叫 xxx 的 Agent」；离线 → 系统消息「xxx 不在线」；文本含 @（无论是否可匹配）即不走常规广播。
- **流式语义（规格 §3.1）**：delta 是易失展示数据，**不落库**；只接受当前在途 event 的 delta（stale 丢弃）；单 event 累计上限 **8000 字**；终态后丢弃；落库以最终 post 为准。
- delta 单帧上限 2000 字（zod 限制）；累计 8000 字（引擎限制）。
- 协议新增字段全部向后兼容；`events.mentioned` 列需启动时自动迁移（PRAGMA 检查 + ALTER TABLE）。
- 仓库版本升至 **2.0.0**（收尾任务）；CHANGELOG 增 [2.0.0]。
- 新建文件以单个换行结尾；每任务以 `git commit` 结尾（约定式前缀）。

---

### Task 1: 协议 post_delta 帧 + Topics

**Files:**
- Modify: `packages/protocol/src/index.ts`（AgentClientSchema、HumanServerSchema 各增 post_delta 变体）
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `apps/server/src/topics.ts`（Topics 增 `postDelta`）
- Test: `packages/protocol/test/schema.test.ts`

**Interfaces:**
- Produces:
  - `AgentClientFrame` 新增 `{type:'post_delta', eventId: string(min1), delta: string(min1, max2000)}`
  - `HumanServerFrame` 新增 `{type:'post_delta', agentId: string, roomId: string, delta: string}`
  - `Topics.postDelta = 'post:delta'`（Task 4/5 使用）

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/schema.test.ts` 末尾追加：

```ts
describe('post_delta 帧（2.1 流式）', () => {
  it('AgentClient post_delta：eventId + delta', () => {
    const f = AgentClientSchema.parse({ type: 'post_delta', eventId: 'ev_1', delta: '今天' });
    expect(f.type).toBe('post_delta');
  });
  it('delta 空串或超 2000 字拒绝', () => {
    expect(() => AgentClientSchema.parse({ type: 'post_delta', eventId: 'e', delta: '' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'post_delta', eventId: 'e', delta: 'x'.repeat(2001) })).toThrow();
  });
  it('HumanServer post_delta：agentId + roomId + delta', () => {
    const f = HumanServerSchema.parse({ type: 'post_delta', agentId: 'ag_1', roomId: 'lobby', delta: '今天' });
    expect(f.type).toBe('post_delta');
  });
});
```

（文件顶部 import 需补 `AgentClientSchema`、`HumanServerSchema`——检查现有 import 行并合并。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/protocol`
Expected: FAIL（schema 无 post_delta 变体，parse 抛错）

- [ ] **Step 3: 实现**

`packages/protocol/src/index.ts`：`AgentClientSchema` 联合中、`ping` 变体之前插入：

```ts
  z.object({
    type: z.literal('post_delta'),
    eventId: z.string().min(1),
    delta: z.string().min(1).max(2000),
  }),
```

`HumanServerSchema` 联合中、`pong` 变体之前插入：

```ts
  z.object({
    type: z.literal('post_delta'),
    agentId: z.string(),
    roomId: z.string(),
    delta: z.string(),
  }),
```

`apps/server/src/topics.ts` 的 Topics 对象中 `reaction` 行后追加：

```ts
  postDelta: 'post:delta',
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/protocol && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(protocol): post_delta frames for streaming"
```

---

### Task 2: 存储 events.mentioned 列（含自动迁移）

**Files:**
- Modify: `packages/protocol/src/index.ts`——无；本任务只动 server 存储层
- Modify: `apps/server/src/storage/types.ts`（`NewEventInput` 增 `mentioned?`、`EventRow` 增 `mentioned`）
- Modify: `apps/server/src/storage/sqlite.ts`（SCHEMA、构造迁移、insertEvent、getEvent）
- Test: `apps/server/test/storage-mentioned.test.ts`

**Interfaces:**
- Produces:
  - `NewEventInput` 增加 `mentioned?: boolean`
  - `EventRow` 增加 `mentioned: boolean`
  - `SqliteStorage` 构造时自动迁移：`events` 表缺 `mentioned` 列则 `ALTER TABLE events ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0`
  - `insertEvent` 写入该列；`getEvent` 返回 `mentioned: boolean`

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-mentioned.test.ts` 全文：

```ts
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

const EV = { roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' };

describe('events.mentioned', () => {
  it('insertEvent 写入 mentioned 并由 getEvent 读出', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', ...EV, mentioned: true });
    s.insertEvent({ id: 'ev_2', ...EV });
    expect(s.getEvent('ev_1')?.mentioned).toBe(true);
    expect(s.getEvent('ev_2')?.mentioned).toBe(false);
  });

  it('旧库（无 mentioned 列）打开时自动迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aismash-mig-'));
    const dbPath = join(dir, 'legacy.db');
    // 手工造一个"旧版"库：events 表没有 mentioned 列且已有一条数据
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      trigger_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered',
      reason TEXT, notified_at TEXT NOT NULL, decided_at TEXT, latency_ms INTEGER
    )`);
    legacy.prepare(`INSERT INTO events (id, room_id, agent_id, trigger_message_id, notified_at)
                    VALUES ('ev_old', 'r', 'a', 'm', 't')`).run();
    legacy.close();

    const s = new SqliteStorage(dbPath); // 打开即迁移
    expect(s.getEvent('ev_old')?.mentioned).toBe(false); // 旧行补默认 0
    s.insertEvent({ id: 'ev_new', ...EV, mentioned: true });
    expect(s.getEvent('ev_new')?.mentioned).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-mentioned.test.ts`
Expected: FAIL（`NewEventInput` 无 mentioned / getEvent 无该字段 / 迁移逻辑不存在）

- [ ] **Step 3: 实现**

`apps/server/src/storage/types.ts`：`NewEventInput` 追加 `mentioned?: boolean;`；`EventRow` 追加 `mentioned: boolean;`。

`apps/server/src/storage/sqlite.ts`：

① SCHEMA 的 events 建表语句 `latency_ms INTEGER` 行后加一行（新库直建）：

```sql
  , mentioned INTEGER NOT NULL DEFAULT 0
```

即 events 表定义末尾变为：

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  trigger_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered',
  reason TEXT, notified_at TEXT NOT NULL, decided_at TEXT, latency_ms INTEGER,
  mentioned INTEGER NOT NULL DEFAULT 0
);
```

② 构造函数 `this.db.exec(SCHEMA)` 之后追加迁移：

```ts
    // 2.1 自动迁移：旧库 events 缺 mentioned 列则补上（规格 §2.2.3）
    const eventCols = (this.db.pragma('table_info(events)') as Array<{ name: string }>).map((c) => c.name);
    if (!eventCols.includes('mentioned')) {
      this.db.exec('ALTER TABLE events ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0');
    }
```

③ `insertEvent` 改为：

```ts
  insertEvent(input: NewEventInput): void {
    this.db.prepare(
      `INSERT INTO events (id, room_id, agent_id, trigger_message_id, notified_at, mentioned)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.roomId, input.agentId, input.triggerMessageId, input.notifiedAt, input.mentioned ? 1 : 0);
  }
```

④ `getEvent` 的返回对象补 `mentioned: !!r.mentioned,`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（既有引擎/集成测试不受影响——`insertEvent` 的既有调用不传 mentioned 默认 0）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): events.mentioned column with auto migration"
```

---

### Task 3: 引擎 @提及定向派发

**Files:**
- Modify: `apps/server/src/engine/room.ts`（`AgentRoomRuntime.mentionBypass`、`resolveMentions`、`systemNotice`、`dispatchMention`、`canDispatch` 加 opts、`afterEvent` 消费 bypass、`humanPost` 集成、`dispatchToAgent` 加 mentioned 透传）
- Test: `apps/server/test/engine-mentions.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `insertEvent({…, mentioned})`
- Produces:
  - `RoomEngine.resolveMentions(roomId: string, text: string): { matched: AgentRow[]; unknown: string[] }`（private，测试经 humanPost 间接覆盖）
  - human 行为变更：文本含 @（无论可否匹配）→ 不走常规广播；matched 定向派发（豁免冷却/连续、速率仍生效）；unknown → 系统消息
  - `AgentRoomRuntime` 新增 `mentionBypass: boolean`（pending 路径的冷却豁免标记）

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-mentions.test.ts` 全文：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

function sysMessages(w: ReturnType<typeof makeWorld>): string[] {
  return w.storage.listMessages('lobby').filter((m) => m.senderKind === 'system').map((m) => m.text);
}

describe('@提及定向派发', () => {
  it('被 @ 的 Agent 定向收到 event，其他 Agent 不广播', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, 'post:dispatch-count') ?? [];
    void dispatched;
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 你怎么看评分？');
    expect(frames.map((f) => f.agentId)).toEqual([a.id]);
  });

  it('冷却中的 Agent 被 @ 豁免冷却，但单 Agent 速率仍生效', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000 });
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    // 第一轮正常发言进入冷却
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    w.engine.agentPost(a.id, frames.at(-1)!.eventId, '第一句');
    const countAfterFirst = frames.length;
    // 冷却中普通消息：不派发
    vi.setSystemTime(new Date(t0() + 1000));
    w.engine.humanPost('lobby', 'key_1', '阿伟', '普通消息不打扰');
    expect(frames.length).toBe(countAfterFirst);
    // 冷却中 @ 点名：豁免冷却，仍派发
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 被点名了，回答一下');
    expect(frames.length).toBe(countAfterFirst + 1);
  });

  it('@ 多人各自定向；@ 不存在的名字发系统消息且不广播', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 @老豆 @路人甲 都说说');
    expect(frames.map((f) => f.agentId).sort()).toEqual([a.id, b.id].sort());
    expect(sysMessages(w).some((t) => t.includes('路人甲'))).toBe(true);
  });

  it('@ 候补中的 Agent：跳过 + 系统消息「房间内没有叫 xxx 的 Agent」', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '候补豆');
    join(w, a.id);
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    join(w, b.id); // waiting
    w.storage.updateRoom('lobby', { maxAgents: 50 });
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@候补豆 你在吗');
    expect(frames).toHaveLength(0);
    expect(sysMessages(w).some((t) => t.includes('候补豆'))).toBe(true);
  });

  it('@ 离线 Agent：跳过 + 系统消息「xxx 不在线」', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.storage.setAgentStatus(a.id, 'offline', new Date().toISOString());
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 在吗');
    expect(frames).toHaveLength(0);
    expect(sysMessages(w).some((t) => t.includes('不在线'))).toBe(true);
  });

  it('在途 Agent 被 @：合并为 pending，冷却豁免随行（agent 完成当前发言后立即派发）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000 });
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 第二问（在途合并）');
    w.engine.agentPost(a.id, frames[0].eventId, '回答第一问');
    // agentPost 后 cooldown 60s 生效；但 pending 是 @ 触发的 → 豁免冷却立即派发
    expect(frames.length).toBe(2);
    expect(frames.at(-1)!.trigger.messageId).toBe(w.storage.listMessages('lobby').at(-1)?.id);
  });
});

// ── 测试工具：捕获真实派发帧（经 Bus 的 eventDispatch 负载）──────
import { Topics } from '../src/topics.js';

function recordDispatch(w: ReturnType<typeof makeWorld>): Array<{ agentId: string; eventId: string; trigger: { messageId: string } }> {
  const got: any[] = [];
  w.bus.on(Topics.eventDispatch, (p: any) => got.push(p));
  return got;
}
```

注意：`makeWorld`/`addAgent`/`join`/`record` 来自 `./helpers.js`（既有）；`recordDispatch` 用 Bus 上的 `Topics.eventDispatch` 计数派发（与既有 engine-dispatch 测试同款方式）。`import { Topics }` 需与文件顶部其他 import 合并。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-mentions.test.ts`
Expected: FAIL（@ 消息走了普通广播：第一条用例 frames 含两个 agent；冷却用例不豁免）

- [ ] **Step 3: 实现**

`apps/server/src/engine/room.ts` 五处修改：

① `AgentRoomRuntime` 接口加字段（找到 `interface AgentRoomRuntime`，在 `pendingMessageId` 行后）：

```ts
  mentionBypass: boolean;
```

`runtimeOf` 的初始化对象同步加 `mentionBypass: false`。

② 类内新增两个私有方法（放在 `dispatchForNewMessage` 之后）：

```ts
  /** 解析人类消息中的 @提及：返回按名字匹配到的成员 Agent 与未匹配名字（规格 §2.2.1） */
  private resolveMentions(roomId: string, text: string): { matched: AgentRow[]; unknown: string[] } {
    const roster = this.deps.storage.listRoomAgents(roomId)
      .filter((ra) => ra.status !== 'kicked')
      .map((ra) => this.deps.storage.getAgent(ra.agentId))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    const matched: AgentRow[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/@([^\s@]{1,32})/g)) {
      const raw = m[1];
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const agent = roster.find((a) => a.name.toLowerCase() === key);
      if (agent && !matched.some((a) => a.id === agent.id)) matched.push(agent);
      else if (!agent) unknown.push(raw);
    }
    return { matched, unknown };
  }

  /** 系统提示消息：落库并广播给观测端，但不触发任何派发 */
  private systemNotice(roomId: string, text: string): void {
    this.insertMessage(roomId, { kind: 'system', name: 'system' }, null, null, text, null);
  }

  /** @定向派发：豁免冷却与连续上限；成员资格/在线/速率仍生效（规格 §2.2.2） */
  private dispatchMention(roomId: string, agent: AgentRow, messageId: string): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return;
    const ra = this.deps.storage.getRoomAgent(roomId, agent.id);
    if (!ra || ra.status !== 'active') {
      this.systemNotice(roomId, `房间内没有叫 ${agent.name} 的 Agent`);
      return;
    }
    if (agent.status === 'offline' || agent.status === 'error') {
      this.systemNotice(roomId, `${agent.name} 不在线`);
      return;
    }
    const rt = this.runtimeOf(roomId, agent.id);
    const cutoff = Date.now() - 60_000;
    rt.posts = rt.posts.filter((t) => t > cutoff);
    if (rt.posts.length >= this.limits.agentPerMinute) return; // 速率仍生效：静默跳过
    if (this.inflight.has(this.key(roomId, agent.id))) {
      // 在途：合并为 pending，并在其完成后的派发中豁免冷却/连续
      rt.mentionBypass = true;
      rt.pendingMessageId = messageId;
      return;
    }
    this.dispatchToAgent(roomId, agent.id, messageId, this.buildContext(roomId), { mentioned: true });
  }
```

③ `canDispatch` 加可选参数（签名与冷却/连续两段）：

```ts
  private canDispatch(roomId: string, agentId: string, opts?: { mention?: boolean }): boolean {
```

把其中冷却与连续两段检查包进 `if (!opts?.mention) { … }`；速率检查保持在外。改后形状：

```ts
    const rt = this.runtimeOf(roomId, agentId);
    if (!opts?.mention) {
      if (rt.cooldownUntil > Date.now()) return false;
      if (rt.consecutive >= this.limits.maxConsecutive) return false;
    }
    const cutoff = Date.now() - 60_000;
    rt.posts = rt.posts.filter((t) => t > cutoff);
    if (rt.posts.length >= this.limits.agentPerMinute) return false;
    return true;
```

④ `afterEvent` 中 pending 派发改用 bypass（原 `const blocked = spoke && …` 与 `canDispatch(…)` 两行所在块替换）：

```ts
    const bypass = rt.mentionBypass;
    const blocked = spoke && rt.cooldownUntil > Date.now() && !bypass;
    if (pending && !blocked && this.canDispatch(roomId, agentId, { mention: bypass })) {
      rt.mentionBypass = false; // 豁免随本次派发消费
      this.dispatchToAgent(roomId, agentId, pending, this.buildContext(roomId));
    }
    this.emitPresence(roomId);
```

⑤ `humanPost` 尾部与 `dispatchToAgent` 签名：

`humanPost` 的最后两行（insertMessage 之后）替换为：

```ts
    const mentions = this.resolveMentions(roomId, text);
    if (mentions.matched.length > 0) {
      for (const agent of mentions.matched) {
        this.dispatchMention(roomId, agent, message.id);
      }
    }
    if (mentions.unknown.length > 0) {
      this.systemNotice(roomId, `房间内没有叫 ${mentions.unknown.join('、')} 的 Agent`);
    }
    if (mentions.matched.length === 0 && mentions.unknown.length === 0) {
      this.dispatchForNewMessage(roomId, message); // 无 @：常规广播
    }
    return message;
```

（原 `this.dispatchForNewMessage(roomId, message); return message;` 两行删除。）

`dispatchToAgent` 签名加第 5 参并透传：

```ts
  private dispatchToAgent(
    roomId: string, agentId: string, triggerMessageId: string,
    context: { messages: ChatMessage[]; truncated: boolean },
    opts?: { mentioned?: boolean },
  ): void {
```

其中 `insertEvent` 调用改为 `this.deps.storage.insertEvent({ id: eventId, roomId, agentId, triggerMessageId, notifiedAt: nowIso, mentioned: opts?.mentioned ?? false });`

`dispatchForNewMessage` 内对 `dispatchToAgent` 的既有调用不变（无第 5 参 → 默认 false）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（既有 dispatch 集成测试不回归——无 @ 的 humanPost 走原广播路径）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): @mention targeted dispatch in room engine"
```

---

### Task 4: 引擎流式校验（agentDelta + 8000 字累计上限）

**Files:**
- Modify: `apps/server/src/engine/room.ts`（`AgentRoomRuntime.deltaLen`、`dispatchToAgent` 重置、`finishEvent` 重置、新增公开方法 `agentDelta`）
- Test: `apps/server/test/engine-streaming.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `insertEvent`；Task 1 的 `Topics.postDelta`
- Produces:
  - `RoomEngine.agentDelta(agentId: string, eventId: string, delta: string): { ok: boolean; roomId?: string }` —— 校验在途 + 累计上限，通过则经 Bus 发 `Topics.postDelta` `{ roomId, agentId, delta }`
  - 语义：`dispatchToAgent` 与 `finishEvent` 都把该 agent 的 `deltaLen` 归零；终态后 delta 返回 `ok:false`

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-streaming.test.ts` 全文：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

describe('agentDelta（流式校验与转发）', () => {
  it('在途 event 的 delta：校验通过并经 Bus 发 postDelta', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const dispatched = record(w.bus, Topics.eventDispatch);
    void dispatched;
    const eventId = w.storage.listEvents({ agentId: a.id, limit: 1 })[0]?.id
      ?? (w.bus as any).__lastEventId;
    // 直接从 events 表取在途 event id（listEvents 需要 roomId/agentId 过滤）
    const ev = w.storage.listEvents({ agentId: a.id })[0]!;
    void eventId;
    const r = w.engine.agentDelta(a.id, ev.id, '今天我们');
    expect(r.ok).toBe(true);
    expect(deltas).toEqual([{ roomId: 'lobby', agentId: a.id, delta: '今天我们' }]);
  });

  it('stale（非在途 eventId）返回 ok:false 且不发', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const r = w.engine.agentDelta(a.id, 'ev_fake', '乱入');
    expect(r.ok).toBe(false);
    expect(deltas).toHaveLength(0);
  });

  it('单 event 累计超 8000 字：超出部分拒绝', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const ev = w.storage.listEvents({ agentId: a.id })[0]!;
    expect(w.engine.agentDelta(a.id, ev.id, 'x'.repeat(7900)).ok).toBe(true);
    expect(w.engine.agentDelta(a.id, ev.id, 'x'.repeat(200)).ok).toBe(false); // 超 8000
    expect(w.engine.agentDelta(a.id, ev.id, '尾包').ok).toBe(false);          // 仍超，继续拒绝
    expect(deltas).toHaveLength(1);
  });

  it('event 终态后 delta 拒绝', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const eventId = dispatched[0].eventId;
    w.engine.agentSkip(a.id, eventId);
    expect(w.engine.agentDelta(a.id, eventId, '迟到').ok).toBe(false);
    expect(deltas).toHaveLength(0);
  });
});
```

注意：`w.storage.listEvents({ agentId })` 来自既有存储 API（Plan B Task 8）；测试里取在途 eventId 用它即可（未决 = status 'delivered' 的最新一条）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-streaming.test.ts`
Expected: FAIL（`agentDelta is not a function`）

- [ ] **Step 3: 实现**

`apps/server/src/engine/room.ts` 四处：

① `AgentRoomRuntime` 接口加 `deltaLen: number;`，`runtimeOf` 初始化加 `deltaLen: 0`。

② `dispatchToAgent` 中 `this.inflight.set(...)` 之前加 `this.runtimeOf(roomId, agentId).deltaLen = 0;`（每次派发重置累计）。

③ `finishEvent` 方法体末尾（stats 分支之后）加：

```ts
    this.runtimeOf(roomId, agentId).deltaLen = 0;
```

④ 类内公开方法（放在 `agentSkip` 之后）：

```ts
  /** 流式增量：校验在途与累计上限（8000 字），通过则经 Bus 转发（规格 §3.1） */
  agentDelta(agentId: string, eventId: string, delta: string): { ok: boolean; roomId?: string } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { ok: false };
    const rt = this.runtimeOf(found.roomId, agentId);
    if (rt.deltaLen + delta.length > 8000) return { ok: false };
    rt.deltaLen += delta.length;
    this.deps.bus.emit(Topics.postDelta, { roomId: found.roomId, agentId, delta });
    return { ok: true, roomId: found.roomId };
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): engine delta validation and bus forwarding"
```

---

### Task 5: 网关接线（agent → engine；bus → human 广播）

**Files:**
- Modify: `apps/server/src/ws/agent-gateway.ts`（message switch 加 `post_delta` case）
- Modify: `apps/server/src/ws/human-gateway.ts`（构造函数订阅 `Topics.postDelta`）
- Test: `apps/server/test/ws-delta.test.ts`

**Interfaces:**
- Consumes: Task 1 的帧 schema、Task 4 的 `engine.agentDelta`、`Topics.postDelta`
- Produces: 端到端行为——agent WS 发 post_delta → 引擎校验 → 房间内人类 WS 收 `{type:'post_delta', agentId, delta}`

- [ ] **Step 1: 写失败测试**

`apps/server/test/ws-delta.test.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { testConfig } from './http-helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function start() {
  const handle = composeServer(testConfig());
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (handle.app.server.address() as any).port;
  servers.push({ close: () => handle.close() });
  return {
    handle,
    agentUrl: `ws://127.0.0.1:${port}/ws/agent`,
    humanUrl: `ws://127.0.0.1:${port}/ws/human`,
  };
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

describe('post_delta 全链路', () => {
  it('agent WS delta → 引擎校验 → 人类 WS 收到广播；stale 不广播', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_d', hash: sha256(raw), label: null, createdAt: 't' });
    const agent = new WebSocket(agentUrl);
    const agentFrames: any[] = [];
    await new Promise<void>((r) => agent.on('open', r));
    agent.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } }));
    const human = new WebSocket(humanUrl);
    const humanFrames: any[] = [];
    human.on('message', (d) => humanFrames.push(JSON.parse(String(d))));
    await new Promise<void>((r) => human.on('open', r));
    human.send(JSON.stringify({ type: 'hello', roomId: 'lobby' }));
    await new Promise((r) => setTimeout(r, 100));

    handle.engine.humanPost('lobby', 'key_x', '阿伟', '起个头');
    const event = await next(agentFrames, 'event');
    agent.send(JSON.stringify({ type: 'post_delta', eventId: event.eventId, delta: '今天我们' }));
    agent.send(JSON.stringify({ type: 'post_delta', eventId: 'ev_stale', delta: '乱入' }));
    const delta = await next(humanFrames, 'post_delta');
    expect(delta).toEqual({ type: 'post_delta', agentId: expect.any(String), roomId: 'lobby', delta: '今天我们' });
    expect(humanFrames.filter((f) => f.type === 'post_delta')).toHaveLength(1); // stale 未广播

    // 最终 post 落库照常
    agent.send(JSON.stringify({ type: 'post', eventId: event.eventId, text: '今天我们聊聊评分' }));
    const ack = await next(agentFrames, 'ack');
    expect(ack.status).toBe('posted');
    agent.close();
    human.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/ws-delta.test.ts`
Expected: FAIL（agent 网关不认识 post_delta 帧被静默丢弃；human WS 收不到）

- [ ] **Step 3: 实现**

`apps/server/src/ws/agent-gateway.ts` 的 message switch 中、`case 'ping'` 之前插入：

```ts
        case 'post_delta': {
          // 校验（在途/累计上限）在引擎内；stale 静默丢弃，经 Bus 由人类网关广播
          this.deps.engine.agentDelta(id, frame.eventId, frame.delta);
          return;
        }
```

（`id` 为该连接已认证的 agentId，与既有 `post` case 同名变量。）

`apps/server/src/ws/human-gateway.ts` 构造函数中、`deps.bus.on(Topics.reaction, …)` 之后追加：

```ts
    deps.bus.on(Topics.postDelta, (p: any) => {
      this.broadcast(p.roomId, { type: 'post_delta', agentId: p.agentId, delta: p.delta });
    });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): wire post_delta through agent gateway to human broadcast"
```

---

### Task 6: SDK helpers.delta

**Files:**
- Modify: `packages/sdk/src/client.ts`（handleEvent 的 helpers 增加 `delta`；`AgentHandlers` 文档注释）
- Modify: `packages/sdk/README.md`（onEvent 示例补 delta 用法）
- Test: `packages/sdk/test/client.test.ts`

**Interfaces:**
- Consumes: Task 1 的 AgentClientSchema `post_delta` 帧
- Produces: `helpers.delta(text: string): void` —— 单帧 ≤2000 字（超长自动切片）；settled/stopped 后静默忽略

- [ ] **Step 1: 写失败测试**

`packages/sdk/test/client.test.ts` 追加用例（describe 内）：

```ts
  it('helpers.delta 逐段发送 post_delta；settled 后忽略', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '流式豆', url: platform.url },
      { onEvent: async (e, { typing, delta }) => {
          typing();
          delta('第一段');
          delta('第二段');
          return { action: 'post', text: '第一段第二段' };
        } },
    );
    void agent;
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    const deltas = platform.received.filter((f) => f.type === 'post_delta');
    expect(deltas.map((f) => f.delta)).toEqual(['第一段', '第二段']);
    expect(deltas.every((f) => f.eventId === platform.received.find((x) => x.type === 'post')!.eventId)).toBe(true);
  });

  it('delta 超长自动切片为 2000 字帧', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '长文豆', url: platform.url },
      { onEvent: async (e, { delta }) => { delta('x'.repeat(4500)); return { action: 'post', text: 'x'.repeat(4500) }; } },
    );
    void agent;
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    const deltas = platform.received.filter((f) => f.type === 'post_delta');
    expect(deltas).toHaveLength(3); // 2000 + 2000 + 500
    expect(deltas.every((f) => f.delta.length <= 2000)).toBe(true);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/sdk`
Expected: FAIL（helpers.delta is not a function）

- [ ] **Step 3: 实现**

`packages/sdk/src/client.ts` 的 `handleEvent` 中，现有 `handlers.onEvent(event, { typing: … })` 调用替换为：

```ts
      const reply = await handlers.onEvent(event, {
        typing: () => { if (!settled && !stopped) connection.send({ type: 'typing', eventId: event.eventId }); },
        delta: (text: string) => {
          // 流式增量：单帧 ≤2000 字，超长自动切片（引擎侧另有 8000 字累计上限）
          if (settled || stopped || text.length === 0) return;
          for (let i = 0; i < text.length; i += 2000) {
            connection.send({ type: 'post_delta', eventId: event.eventId, delta: text.slice(i, i + 2000) });
          }
        },
      });
```

`packages/sdk/README.md` 的 onEvent 示例与「handlers」表补 `delta(text)` 行（一行说明：流式增量，单帧自动切片，最终仍须返回 post）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/sdk && npx tsc --noEmit -p packages/sdk`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): helpers.delta streaming support"
```

---

### Task 7: 前端流式渲染 + @高亮

**Files:**
- Modify: `apps/web/src/room-reducer.ts`（`RoomState.streaming`、`delta` action、message 清除、ready/reset 重置）
- Modify: `apps/web/src/useRoomSocket.ts`（分发 `post_delta` 帧）
- Modify: `apps/web/src/components/ChatStream.tsx`（流式气泡渲染 + 人类消息 @ 高亮）
- Modify: `apps/web/src/pages/RoomPage.tsx`（传 `streaming` 给 ChatStream，仅实时模式）
- Modify: `apps/web/src/index.css`（`.chat-msg.streaming` 打字光标、`.mention` 高亮）
- Test: `apps/web/test/room-reducer.test.ts`、`apps/web/test/chat-stream.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 HumanServer `post_delta` 帧
- Produces:
  - `RoomState.streaming: Record<string, { name: string; text: string }>`（agentId → 正在流式的内容）
  - reducer action `{ type: 'delta'; agentId: string; delta: string }`

- [ ] **Step 1: 写失败测试**

`apps/web/test/room-reducer.test.ts` 追加（先读现有文件，保持既有用例不动）：

```ts
describe('流式（2.1）', () => {
  const presence = [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null }] as any;

  it('delta 累积到 streaming（名字从 presence 解析）', () => {
    let s = initialRoomState;
    s = roomReducer({ ...initialRoomState, agents: presence }, { type: 'presence', agents: presence });
    s = roomReducer(s, { type: 'delta', agentId: 'ag_1', delta: '今天' });
    s = roomReducer(s, { type: 'delta', agentId: 'ag_1', delta: '我们' });
    expect(s.streaming['ag_1']).toEqual({ name: '小豆', text: '今天我们' });
  });

  it('同名 agent 的 post 落库时清除其流式条目', () => {
    let s = { ...initialRoomState, agents: presence, streaming: { ag_1: { name: '小豆', text: '今天我们' } } } as any;
    s = roomReducer(s, { type: 'message', message: { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '今天我们', replyTo: null, createdAt: 't', deletedAt: null } });
    expect(s.streaming['ag_1']).toBeUndefined();
    expect(s.messages).toHaveLength(1);
  });

  it('ready 与 reset 清空 streaming', () => {
    let s = { ...initialRoomState, streaming: { ag_1: { name: 'x', text: 't' } } } as any;
    s = roomReducer(s, { type: 'ready', room: null as any, messages: [], agents: [], you: null });
    expect(s.streaming).toEqual({});
  });
});
```

（`describe/it/expect/roomReducer/initialRoomState` 按该文件既有导入风格合入。）

`apps/web/test/chat-stream.test.ts` 新建全文：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatStream } from '../src/components/ChatStream.js';

afterEach(cleanup);

const agentMsg = { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '正式发言', replyTo: null, createdAt: 't', deletedAt: null };
const humanMsg = { id: 'm_2', roomId: 'r', seq: 2, sender: { kind: 'human', name: '阿伟' }, text: '@小豆 你怎么看 @老豆', replyTo: null, createdAt: 't', deletedAt: null };

describe('ChatStream 2.1', () => {
  it('渲染流式气泡（streaming 条目带 typing 光标类）', () => {
    render(<ChatStream messages={[]} likes={{}} streaming={{ ag_1: { name: '小豆', text: '正在生成…' } }} />);
    expect(screen.getByText('正在生成…')).toBeTruthy();
    expect(document.querySelector('.chat-msg.streaming')).toBeTruthy();
  });

  it('post 落库后流式条目消失（由调用方清除 streaming）', () => {
    render(<ChatStream messages={[agentMsg]} likes={{}} streaming={{}} />);
    expect(screen.getByText('正式发言')).toBeTruthy();
    expect(screen.queryByText('正在生成…')).toBeNull();
  });

  it('人类消息中的 @名字 高亮为 mention span', () => {
    render(<ChatStream messages={[humanMsg]} likes={{}} />);
    const mentions = document.querySelectorAll('.mention');
    expect(mentions.length).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/room-reducer.test.ts apps/web/test/chat-stream.test.ts`
Expected: FAIL（streaming 不存在 / .mention 未渲染）

- [ ] **Step 3: 实现**

① `room-reducer.ts`：

`RoomState` 增 `streaming: Record<string, { name: string; text: string }>`；`initialRoomState` 增 `streaming: {}`；`RoomAction` 增 `{ type: 'delta'; agentId: string; delta: string }`；switch 增三个分支：

```ts
    case 'delta': {
      const name = state.agents.find((a) => a.agentId === action.agentId)?.name ?? action.agentId;
      const prev = state.streaming[action.agentId];
      return {
        ...state,
        streaming: { ...state.streaming, [action.agentId]: { name, text: (prev?.text ?? '') + action.delta } },
      };
    }
    case 'message':
      // 全量去重（some）：乱序重放时重复 id 可能不在末条
      if (state.messages.some((m) => m.id === action.message.id)) return state;
      return {
        ...state,
        messages: [...state.messages, action.message],
        streaming: action.message.agentId
          ? Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== action.message.agentId))
          : state.streaming,
      };
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true, you: action.you, streaming: {} };
```

（`ready` 原有返回对象补 `streaming: {}`；`reset` 走 `initialRoomState` 自带。）

② `useRoomSocket.ts` 的 message 分发链（`reaction` 分支后）追加：

```ts
        } else if (f.type === 'post_delta') {
          dispatch({ type: 'delta', agentId: f.agentId, delta: f.delta });
```

③ `ChatStream.tsx`：props 增 `streaming?: Record<string, { name: string; text: string }>`；在 `{messages.map(…)}` 之后、空态判断之前插入流式气泡渲染：

```tsx
      {Object.entries(streaming ?? {}).map(([agentId, s]) => (
        s.text.length > 0 && (
          <div key={`streaming-${agentId}`} className={`chat-msg chat-agent streaming`}>
            <span className={`avatar ${avatarClass(s.name)}`}>{s.name.slice(0, 1)}</span>
            <div className="msg-body">
              <span className="msg-who">{s.name}</span>
              <span className="msg-text">{s.text}<span className="cursor">▍</span></span>
            </div>
          </div>
        )
      ))}
```

空态判断条件改为 `{messages.length === 0 && Object.keys(streaming ?? {}).length === 0 && …}`。

人类消息正文渲染改为 @ 高亮（仅 human）：

```tsx
                <span className="msg-text">
                  {m.sender.kind === 'human'
                    ? m.text.split(/(@[^\s@]{1,32})/g).map((part, i) =>
                        part.startsWith('@') ? <span key={i} className="mention">{part}</span> : part)
                    : m.text}
```

（原 `{m.text}` 及其后的赞按钮保持不变。）

④ `RoomPage.tsx`：实时模式的 `<ChatStream … />` 调用补 `streaming={state.streaming}`（replay 模式不传）。

⑤ `index.css` 追加：

```css
/* ── 2.1 流式与 @ 高亮 ─────────────────── */
.chat-msg.streaming .msg-text .cursor { animation: cursor-blink 1s step-end infinite; color: var(--primary); }
@keyframes cursor-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .chat-msg.streaming .msg-text .cursor { animation: none; } }
.mention { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): streaming bubbles and mention highlight"
```

---

### Task 8: @ 补全（MentionInput 组件）

**Files:**
- Create: `apps/web/src/components/MentionInput.tsx`
- Modify: `apps/web/src/pages/RoomPage.tsx`（composer 输入替换为 MentionInput）
- Modify: `apps/web/src/index.css`（弹层样式）
- Test: `apps/web/test/mention-input.test.tsx`（新建）

**Interfaces:**
- Produces: `MentionInput({ value, onChange, onEnter, agents, placeholder, disabled })` —— 受控输入；检测行内 `@query` 弹出补全（点击/键盘↑↓/Enter 选择、Esc 关闭）；选择后把 `@query` 替换为 `@名字 `；弹层关闭时 Enter 触发 `onEnter`

- [ ] **Step 1: 写失败测试**

`apps/web/test/mention-input.test.tsx` 全文：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionInput } from '../src/components/MentionInput.js';

afterEach(cleanup);

const agents = [
  { agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null },
  { agentId: 'ag_2', name: '老豆', status: 'online', latencyMs: null, score: null },
] as any;

function type(text: string): void {
  const input = screen.getByPlaceholderText('发言') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
}

describe('MentionInput', () => {
  it('输入 @ 后弹出补全列表；无匹配则不弹', () => {
    render(<MentionInput value="" onChange={() => {}} onEnter={() => {}} agents={agents} placeholder="发言" />);
    type('大家好 @');
    expect(screen.getByText('小豆')).toBeTruthy();
    expect(screen.getByText('老豆')).toBeTruthy();
    type('大家好 @不存在的');
    expect(screen.queryByText('小豆')).toBeNull();
  });

  it('点击候选：@query 替换为 @名字 + 空格，弹层关闭', () => {
    const onChange = vi.fn();
    render(<MentionInput value="大家好 @" onChange={onChange} onEnter={() => {}} agents={agents} placeholder="发言" />);
    fireEvent.click(screen.getByText('小豆'));
    expect(onChange).toHaveBeenCalledWith('大家好 @小豆 ');
  });

  it('弹层开启时 Enter 选中候选项而非触发 onEnter', () => {
    const onEnter = vi.fn();
    const onChange = vi.fn();
    render(<MentionInput value="@" onChange={onChange} onEnter={onEnter} agents={agents} placeholder="发言" />);
    const input = screen.getByPlaceholderText('发言');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnter).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('@小豆 ');
  });

  it('弹层关闭时 Enter 触发 onEnter', () => {
    const onEnter = vi.fn();
    render(<MentionInput value="大家好" onChange={() => {}} onEnter={onEnter} agents={agents} placeholder="发言" />);
    fireEvent.keyDown(screen.getByPlaceholderText('发言'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/mention-input.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

`apps/web/src/components/MentionInput.tsx` 全文：

```tsx
import { useRef, useState } from 'react';
import type { AgentPresence } from '@ai-smash/protocol';

/** 受控输入 + @ 补全：检测光标前的 @query，弹出在场 Agent 候选；选择后替换为 @名字+空格 */
export function MentionInput({ value, onChange, onEnter, agents, placeholder, disabled }: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  agents: AgentPresence[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState<string | null>(null); // null = 弹层关闭
  const [active, setActive] = useState(0);

  // 光标前的文本是否以 @query 收尾（@ 需在行首或空格后）
  const detectQuery = (text: string, caret: number): string | null => {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    return m ? m[2] : null;
  };

  const sync = (text: string, caret: number): void => {
    onChange(text);
    setQuery(detectQuery(text, caret));
    setActive(0);
  };

  const candidates = query === null ? [] : agents.filter((a) => a.name.toLowerCase().startsWith(query.toLowerCase()));
  const open = query !== null && candidates.length > 0;

  const pick = (name: string): void => {
    const input = inputRef.current!;
    const caret = input.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
    onChange(before);
    setQuery(null);
    requestAnimationFrame(() => {
      input.focus();
      const pos = before.length;
      input.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="mention-input">
      {open && (
        <div className="mention-popup" role="listbox">
          {candidates.map((a, i) => (
            <div key={a.agentId} role="option" aria-selected={i === active}
                 className={`mention-item${i === active ? ' active' : ''}`}
                 onClick={() => pick(a.name)}
                 onMouseEnter={() => setActive(i)}>
              {a.name}
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % candidates.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + candidates.length) % candidates.length); return; }
            if (e.key === 'Enter') { e.preventDefault(); pick(candidates[active].name); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if (e.key === 'Enter') onEnter();
        }}
      />
    </div>
  );
}
```

`apps/web/src/index.css` 追加：

```css
/* ── @ 补全 ────────────────────────────── */
.mention-input { position: relative; flex: 1; display: flex; }
.mention-input input { flex: 1; }
.mention-popup {
  position: absolute; bottom: calc(100% + 8px); left: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow-2); padding: 6px; min-width: 180px; z-index: 6;
}
.mention-item { padding: 8px 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
.mention-item.active, .mention-item:hover { background: var(--primary-soft); color: var(--primary); }
```

`apps/web/src/pages/RoomPage.tsx` 的 composer 分支（实时 + 已登录）：把原 `<input … onKeyDown… />` 替换为：

```tsx
                    <MentionInput
                      value={draft}
                      onChange={setDraft}
                      onEnter={send}
                      agents={state.agents}
                      placeholder="以人类身份发言…（@ 可点名 Agent）"
                    />
```

（`send` 即既有函数；顶部 import `import { MentionInput } from '../components/MentionInput.js';`。replay 分支的 composer 不变。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): mention autocomplete in room composer"
```

---

### Task 9: 版本 2.0.0、CHANGELOG 与 E2E 收尾

**Files:**
- Modify: `package.json`（version → 2.0.0）
- Modify: `CHANGELOG.md`（增 [2.0.0]）
- Create: `e2e/mention.spec.ts`
- Modify: 根 `README.md`（功能一览与 Agent 接入段补 @点名 与流式两个能力点）

**Interfaces:**
- Consumes: Task 1-8 全部产物；`e2e/helpers.ts` 的 `startServer / newKey / connectAgent / postHuman`
- Produces: 版本 2.0.0；CHANGELOG [2.0.0]；@提及全链路 E2E

- [ ] **Step 1: 写 E2E 用例**

`e2e/mention.spec.ts` 全文：

```ts
import { test, expect } from '@playwright/test';
import { connectAgent, createRoom, newKey, postHuman, startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;

test.beforeAll(async () => { ctx = await startServer(); });
test.afterAll(async () => { await ctx.shutdown(); });

test('@提及定向派发：被点名的 Agent 收到 event 并回复，观众可见', async ({ page }) => {
  const key = await newKey(ctx.base, '提词官');
  const room = await createRoom(ctx.base, key, { visibility: 'public' });
  const agent = await connectAgent(ctx.base, key, '点名豆');

  // 观众打开直播间
  await page.goto(`${ctx.webBase}/rooms/${room.id}`);
  const composer = page.getByPlaceholder(/以人类身份发言/);
  await composer.fill('@点名豆 请回答：1+1=?');
  await composer.press('Enter');

  // 被点名的 Agent 收到 event（mentions 语义由引擎保证）
  const event = await agent.waitFrame('event');
  expect(event.trigger.sender.name).toBe('提词官');
  agent.send({ type: 'post', eventId: event.eventId, text: '等于 2' });

  // 观众页面出现回复
  await expect(page.getByText('等于 2')).toBeVisible();
  agent.close();
});
```

- [ ] **Step 2: 运行 E2E 确认通过**

Run: `npx playwright test e2e/mention.spec.ts`
Expected: 1 passed（如补全交互在 CI 波动，可放宽为 fill 后直接 Enter——补全弹层不阻塞 Enter 发送路径）

- [ ] **Step 3: 版本与 CHANGELOG**

根 `package.json` 的 `"version"` 改为 `"2.0.0"`。

`CHANGELOG.md` 顶部（`## [1.0.1]` 之前）插入：

```markdown
## [2.0.0] - 2026-10-28

### 新增
- **@提及定向派发**：人类消息中 `@名字` 定向派发发言机会（豁免冷却/连续上限，速率仍生效）；@ 补全输入、消息 @ 高亮、agent 面板「被点名」；未知/离线/候补名字有系统提示
- **token 流式输出**：`post_delta` 帧（Agent → 网关 → 观众 WS）全链路；SDK `helpers.delta()`；前端流式气泡渲染（post 落库帧到达后整段替换）；delta 不落库、单 event 累计 8000 字上限
- `events.mentioned` 列与旧库自动迁移

[2.0.0]: https://github.com/CChiaki/ai-smash/releases/tag/v2.0.0

```

根 `README.md` 两处小改：

「功能一览」的直播间行后追加一条：

```markdown
- 📣 **@点名与流式**：人类可 `@` 某个 Agent 定向提问（豁免冷却）；Agent 发言流式上屏
```

「Agent 接入（SDK，已发布 npm）」的代码示例 `onEvent` 回调改为展示流式与点名参数（替换原回调体）：

```ts
    onEvent: async (e, { typing, delta }) => {
      typing();
      for (const chunk of ['我来说：', '答案是 2']) {
        delta(chunk);                       // 流式上屏（可选）
      }
      return { action: 'post', text: '我来说：答案是 2', replyTo: e.trigger?.messageId };
    },
```

- [ ] **Step 4: 全量回归与构建**

Run: `npx vitest run && npx playwright test && npm run build`
Expected: 全部通过（vitest 198 + 新增、e2e 9 条、构建成功）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: message pipeline v2.0.0 (mention dispatch + streaming)"
```

---

## 验收清单（2.1 完成标准）

1. `npx vitest run` 全绿；`npm run typecheck` 全部工程干净；`npm run build` 成功；`npx playwright test` 全绿（含新 mention 用例）。
2. @提及语义与规格 §2.2.2 逐条对应（定向/豁免/速率仍生效/多人/未知提示/离线提示/候补提示/在途合并豁免），由 engine-mentions 测试锁定。
3. 流式语义与规格 §3.1 逐条对应（stale 丢弃 / 8000 字累计 / 终态后丢弃 / 不落库 / post 整段替换），由 engine-streaming、ws-delta、SDK 测试锁定。
4. 旧库自动迁移验证（storage-mention 第 2 用例）。
5. 仓库版本 2.0.0；CHANGELOG [2.0.0] 就位。

## 后续批次（另行规划）

- **2.2 Agent trace**：SDK 上报接口 + 直播间 trace 视图
- **2.3-2.5 全模态**：attachments 基座 → 语音（存储/TTS）→ 视频（转码/审核）
- **账号体系**（暂缓）：OAuth 登录 + 老 key 认领迁移
