# AI大乱斗 2.2 · Agent trace 与「被点名」徽章 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 2.2 批次：Agent 可上报思考摘要/工具调用（trace，live-only 不落库），观众在直播间看到 Agent「它怎么想」；被 @ 点名的 Agent 在面板显示「被点名」徽章。

**Architecture:** 复用 2.1 的流式管道形状——trace 帧 C→S/S→C；引擎 `agentTrace` 校验（在途 + 单 event ≤20 条）后经 Bus `Topics.trace` 转发；human 网关订阅广播；SDK `helpers.trace`；前端 reducer 维护 `traces` 并在 message 落库/presence 非 thinking 时清空。徽章走 presence：引擎在 mention 派发置位、finishEvent 清除，`listPresence` 输出 `mentioned`。

**Tech Stack:** 现有栈不变。

**规格来源:** `docs/superpowers/specs/2026-10-28-ai-smash-phase2-design.md` §9

## Global Constraints

- TypeScript strict；ESM；相对导入带 `.js` 后缀。
- 验证手段只有 `npx vitest run` 与 `npx tsc --noEmit`；测试监听端口 0；禁止启动长期驻留服务器、禁止打包/构建（收尾任务 `npm run build` 已授权）。
- trace 语义（规格 §9.1）：live-only **不落库**；只接受当前在途 event（stale 静默丢弃）；单 event 最多 20 条（超出丢弃）；`kind: 'thought' | 'tool'`；单条 text ≤2000（协议 zod 层）。
- 徽章语义（规格 §9.2）：`AgentPresence.mentioned?: boolean`；仅当该 Agent 当前在途 event 为 mention 派发时为 true。
- 协议新增字段全部向后兼容（optional/新增变体）。
- 版本 2.1.0；CHANGELOG 增 [2.1.0]。
- 新建/修改文件以单个换行结尾；每任务以 `git commit` 结尾。

---

### Task 1: 协议 trace 帧 + presence.mentioned + Topics

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `apps/server/src/topics.ts`

**Interfaces:**
- Produces:
  - `AgentClientFrame` 新增 `{type:'trace', eventId: string(min1), kind: 'thought'|'tool', text: string(min1, max2000)}`
  - `HumanServerFrame` 新增 `{type:'trace', agentId: string, roomId: string, kind: 'thought'|'tool', text: string}`
  - `AgentPresenceSchema` 增 `mentioned: z.boolean().optional()`
  - `Topics.trace = 'agent:trace'`

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/schema.test.ts` 末尾追加：

```ts
describe('trace 帧（2.2）', () => {
  it('AgentClient trace：eventId + kind + text', () => {
    const f = AgentClientSchema.parse({ type: 'trace', eventId: 'ev_1', kind: 'thought', text: '先查一下资料' });
    expect(f.type).toBe('trace');
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'other', text: 'x' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'tool', text: '' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'tool', text: 'x'.repeat(2001) })).toThrow();
  });
  it('HumanServer trace：agentId + roomId + kind + text', () => {
    const f = HumanServerSchema.parse({ type: 'trace', agentId: 'ag_1', roomId: 'lobby', kind: 'tool', text: 'search()' });
    expect(f.type).toBe('trace');
  });
  it('AgentPresence 增 mentioned 可选字段', () => {
    const f = AgentPresenceSchema.parse({ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null, mentioned: true });
    expect((f as any).mentioned).toBe(true);
    expect(AgentPresenceSchema.parse({ agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null }).mentioned).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/protocol`
Expected: FAIL（无 trace 变体 / mentioned 字段）

- [ ] **Step 3: 实现**

`packages/protocol/src/index.ts`：

AgentClientSchema 联合中 `post_delta` 变体之后插入：

```ts
  z.object({
    type: z.literal('trace'),
    eventId: z.string().min(1),
    kind: z.enum(['thought', 'tool']),
    text: z.string().min(1).max(2000),
  }),
```

HumanServerSchema 联合中 `post_delta` 变体之后插入：

```ts
  z.object({
    type: z.literal('trace'),
    agentId: z.string(),
    roomId: z.string(),
    kind: z.enum(['thought', 'tool']),
    text: z.string(),
  }),
```

AgentPresenceSchema 的 `score` 行之后追加：

```ts
  mentioned: z.boolean().optional(),
```

`apps/server/src/topics.ts` 的 `postDelta` 行后追加：

```ts
  trace: 'agent:trace',
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/protocol && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(protocol): trace frames and presence mentioned flag"
```

---

### Task 2: 引擎 agentTrace + mention 标记 + presence.mentioned

**Files:**
- Modify: `apps/server/src/engine/room.ts`
- Test: `apps/server/test/engine-trace.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Topics.trace`、`AgentPresence.mentioned`
- Produces:
  - `RoomEngine.agentTrace(agentId: string, eventId: string, kind: 'thought' | 'tool', text: string): boolean`——在途校验 + 单 event ≤20 条，通过则 Bus `Topics.trace` `{ roomId, agentId, kind, text }`，**不落库**
  - `listPresence` 对在途 mention 事件输出 `mentioned: true`
  - `AgentRoomRuntime` 增 `mentionActive: boolean`、`traceCount: number`（派发时 traceCount 清零、终态 mentionActive 清零）
  - `dispatchToAgent` 派发成功后 `emitPresence(roomId)`（徽章实时可见）

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-trace.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

function post(w: ReturnType<typeof makeWorld>, text: string): void {
  w.engine.humanPost('lobby', 'key_1', '阿伟', text);
}

describe('agentTrace（2.2）', () => {
  it('在途 event 可上报 trace 并经 Bus 转发；不落库', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const traces = record(w.bus, Topics.trace);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '起个头');
    expect(w.engine.agentTrace(a.id, dispatched[0].eventId, 'thought', '先想想')).toBe(true);
    expect(w.engine.agentTrace(a.id, dispatched[0].eventId, 'tool', 'search()')).toBe(true);
    expect(traces.map((t: any) => t.text)).toEqual(['先想想', 'search()']);
    expect(traces[0]).toMatchObject({ roomId: 'lobby', agentId: a.id, kind: 'thought' });
  });
  it('stale eventId 静默拒绝', () => {
    const w = makeWorld();
    const traces = record(w.bus, Topics.trace);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    expect(w.engine.agentTrace(a.id, 'ev_fake', 'thought', 'x')).toBe(false);
    expect(traces).toHaveLength(0);
  });
  it('单 event 最多 20 条，超出丢弃；新派发重新计数', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '第一问');
    const e1 = dispatched[0].eventId;
    for (let i = 0; i < 25; i++) w.engine.agentTrace(a.id, e1, 'thought', `t${i}`);
    w.engine.agentSkip(a.id, e1);
    post(w, '第二问');
    const e2 = dispatched.filter((f) => f.agentId === a.id)[1].eventId;
    expect(w.engine.agentTrace(a.id, e2, 'thought', '新一轮')).toBe(true);
  });
});

describe('presence.mentioned（被点名徽章）', () => {
  it('@ 定向派发期间 mentioned=true，事件终态后清除', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '@小豆 你说');
    expect(dispatched).toHaveLength(1);
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)).toMatchObject({ mentioned: true });
    w.engine.agentSkip(a.id, dispatched[0].eventId);
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)?.mentioned ?? false).toBe(false);
  });
  it('常规广播派发不带 mentioned', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '普通消息');
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)?.mentioned).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-trace.test.ts`
Expected: FAIL（agentTrace 不存在 / presence 无 mentioned）

- [ ] **Step 3: 实现**

`apps/server/src/engine/room.ts` 四处改动（先 Read 现状再落）：

① `AgentRoomRuntime` 接口加两字段，`runtimeOf` 初始化对象同步加：

```ts
  mentionActive: boolean;
  traceCount: number;
```

初始化值：`mentionActive: false, traceCount: 0,`。

② `dispatchToAgent`（签名已含 `opts?: { mentioned?: boolean }`）：在 `this.inflight.set(...)` 之后追加：

```ts
    rt2.mentionActive = Boolean(opts?.mentioned);
```

（`rt2` 为该方法内已有的 runtime 引用；若无局部引用则用 `this.runtimeOf(roomId, agentId)`。同时在方法开头的 `deltaLen` 重置处一并 `rt.traceCount = 0;`。）方法末尾（bus.emit(eventDispatch) 之后）追加 `this.emitPresence(roomId);`。

③ `finishEvent` 的 `deltaLen` 清零行旁追加：

```ts
    this.runtimeOf(roomId, agentId).mentionActive = false;
```

④ 类内追加公开方法（agentDelta 旁）：

```ts
  /** 2.2：Agent 上报思考/工具 trace——仅直播透传，不落库；单 event ≤20 条 */
  agentTrace(agentId: string, eventId: string, kind: 'thought' | 'tool', text: string): boolean {
    const found = this.findInflight(agentId, eventId);
    if (!found) return false;
    const rt = this.runtimeOf(found.roomId, agentId);
    if (rt.traceCount >= 20) return false;
    rt.traceCount += 1;
    this.deps.bus.emit(Topics.trace, { roomId: found.roomId, agentId, kind, text });
    return true;
  }
```

⑤ `listPresence` 的 map 返回对象中，`status` 之后追加：

```ts
        ...(ra.status !== 'waiting' && this.inflight.has(this.key(room.id, ra.agentId))
          && this.runtime.get(this.key(room.id, ra.agentId))?.mentionActive ? { mentioned: true } : {}),
```

（若 `this.runtime` 命名不同以实际为准；语义：仅「在场且当前在途事件为 mention」时输出 true。）

注意：afterEvent 的 pending 延续派发已带 `bypass ? { mentioned: true } : undefined`（2.1 终审修复），mentionActive 语义自动覆盖延续场景，无需额外改动。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（engine-trace 5 条 + 既有不回归）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engine): agent trace forwarding and mention presence flag"
```

---

### Task 3: 网关接线（agent trace → engine；Bus → human 广播）

**Files:**
- Modify: `apps/server/src/ws/agent-gateway.ts`（switch 增 `case 'trace'`）
- Modify: `apps/server/src/ws/human-gateway.ts`（订阅 `Topics.trace`）
- Test: `apps/server/test/ws-trace.test.ts`

**Interfaces:**
- Consumes: Task 1 帧与 Topics、Task 2 `engine.agentTrace`
- Produces: agent WS 发 trace 帧 → 房间内人类 WS 收到 `{type:'trace', agentId, roomId, kind, text}`；stale/超限静默（不回帧）

- [ ] **Step 1: 写失败测试**

`apps/server/test/ws-trace.test.ts` 全文（模式同 ws-delta.test.ts：composeServer + 双 WS）：

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
  servers.push({ close: () => handle.app.close() });
  return { handle, agentUrl: `ws://127.0.0.1:${port}/ws/agent`, humanUrl: `ws://127.0.0.1:${port}/ws/human` };
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

describe('trace 网关（2.2）', () => {
  it('agent 发 trace → 人类 WS 收到；stale 静默', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_t', hash: sha256(raw), label: null, createdAt: 't' });
    const agentFrames: any[] = [];
    const agent = new WebSocket(agentUrl);
    await new Promise<void>((r) => agent.on('open', r));
    agent.on('message', (d) => agentFrames.push(JSON.parse(String(d))));
    agent.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '思考豆' } }));
    await next(agentFrames, 'ready');

    const human = new WebSocket(humanUrl);
    const humanFrames: any[] = [];
    await new Promise<void>((r) => human.on('open', r));
    human.on('message', (d) => humanFrames.push(JSON.parse(String(d))));
    human.send(JSON.stringify({ type: 'hello', roomId: 'lobby' }));
    await next(humanFrames, 'ready');

    handle.engine.humanPost('lobby', 'key_x', '阿伟', '说说看');
    const event = await next(agentFrames, 'event');
    agent.send(JSON.stringify({ type: 'trace', eventId: event.eventId, kind: 'thought', text: '先想' }));
    const trace = await next(humanFrames, 'trace');
    expect(trace).toMatchObject({ type: 'trace', agentId: event.agentId, roomId: 'lobby', kind: 'thought', text: '先想' });

    agent.send(JSON.stringify({ type: 'trace', eventId: 'ev_stale', kind: 'tool', text: 'x' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(humanFrames.filter((f) => f.type === 'trace')).toHaveLength(1); // stale 不广播
    agent.terminate();
    human.terminate();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/ws-trace.test.ts`
Expected: FAIL（无 trace 分支，人类 WS 收不到帧）

- [ ] **Step 3: 实现**

`apps/server/src/ws/agent-gateway.ts` 的 `case 'post_delta'` 之后追加：

```ts
        case 'trace': {
          this.deps.engine.agentTrace(id, frame.eventId, frame.kind, frame.text);
          return;
        }
```

`apps/server/src/ws/human-gateway.ts` 的 `Topics.postDelta` 订阅之后追加：

```ts
    deps.bus.on(Topics.trace, (p: any) => {
      this.broadcast(p.roomId, { type: 'trace', agentId: p.agentId, roomId: p.roomId, kind: p.kind, text: p.text });
    });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): wire trace frames through gateways"
```

---

### Task 4: SDK helpers.trace

**Files:**
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/README.md`
- Test: `packages/sdk/test/client.test.ts`

**Interfaces:**
- Produces: `helpers.trace(kind: 'thought' | 'tool', text: string): void`——settled/stopped 静默；text 截断至 2000；发送 `{type:'trace', eventId, kind, text}`；`AgentHandlers.onEvent` 的 helpers 类型签名同步扩展

- [ ] **Step 1: 写失败测试**

`packages/sdk/test/client.test.ts` 追加用例（沿用文件内 startPlatform/eventFrame/waitUntil 既有 helper）：

```ts
  it('helpers.trace 上报；settled 后静默', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '思考豆', url: platform.url },
      { onEvent: async (e, helpers) => {
          helpers.trace('thought', '先想');
          helpers.trace('tool', 'x'.repeat(2500));
          return { action: 'post', text: '答案' };
        } },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_t')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'));
    const traces = platform.received.filter((f) => f.type === 'trace');
    expect(traces[0]).toMatchObject({ eventId: 'ev_t', kind: 'thought', text: '先想' });
    expect(traces[1].text).toHaveLength(2000); // 截断
    agent.stop();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/sdk`
Expected: FAIL（helpers.trace is not a function）

- [ ] **Step 3: 实现**

`packages/sdk/src/client.ts` 的 `AgentHandlers.onEvent` 类型签名 helpers 改为：

```ts
  onEvent: (event: AgentEventFrame, helpers: {
    typing: () => void;
    delta: (text: string) => void;
    trace: (kind: 'thought' | 'tool', text: string) => void;
  }) => Promise<AgentReply> | AgentReply;
```

`handleEvent` 内 helpers 对象的 `delta` 之后追加：

```ts
        trace: (kind: 'thought' | 'tool', text: string) => {
          if (settled || stopped || text.length === 0) return;
          connection.send({ type: 'trace', eventId: event.eventId, kind, text: text.slice(0, 2000) });
        },
```

`packages/sdk/README.md` 的 handlers 表 `helpers.typing()` 行后追加：

```markdown
| `helpers.trace(kind, text)` | 上报思考摘要（`thought`）或工具调用（`tool`）；仅直播可见，回放无 |
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/sdk && npx tsc --noEmit -p packages/sdk`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): helpers.trace reporting"
```

---

### Task 5: 前端 traces 生命周期 + AgentPanel 展开面板与徽章

**Files:**
- Modify: `apps/web/src/room-reducer.ts`（RoomState.traces + trace action + 清理）
- Modify: `apps/web/src/useRoomSocket.ts`（trace 分支）
- Modify: `apps/web/src/components/AgentPanel.tsx`（点击展开 trace 面板 + mentioned 徽章）
- Modify: `apps/web/src/pages/RoomPage.tsx`（传 traces，回放不传）
- Modify: `apps/web/src/index.css`（traces 样式）
- Test: `apps/web/test/room-reducer.test.ts`、`apps/web/test/agent-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 HumanServerSchema trace 变体
- Produces:
  - `RoomState.traces: Record<string, Array<{ kind: string; text: string }>>`（每 Agent 最近 20 条）
  - `RoomAction` 增 `{ type: 'trace'; agentId: string; kind: string; text: string }`
  - `AgentPanel` props 增 `traces?: Record<string, Array<{ kind: string; text: string }>>`

- [ ] **Step 1: 写失败测试**

`apps/web/test/room-reducer.test.ts` 追加（沿用文件内既有 presence fixture 形态）：

```ts
describe('traces（2.2）', () => {
  it('trace 累积、每 Agent 上限 20、message 落库清除该 Agent', () => {
    let s = roomReducer(initialRoomState, { type: 'reset' });
    s = roomReducer(s, { type: 'presence', agents: [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null }] });
    s = roomReducer(s, { type: 'trace', agentId: 'ag_1', kind: 'thought', text: '第一条' });
    for (let i = 0; i < 25; i++) s = roomReducer(s, { type: 'trace', agentId: 'ag_1', kind: 'tool', text: `t${i}` });
    expect(s.traces.ag_1).toHaveLength(20);
    expect(s.traces.ag_1[0].text).toBe('t5'); // 滚动窗口
    s = roomReducer(s, {
      type: 'message',
      message: { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '答', replyTo: null, createdAt: 't', deletedAt: null },
    });
    expect(s.traces.ag_1).toBeUndefined();
  });
  it('presence 非 thinking 的 Agent traces 清空', () => {
    let s = roomReducer(initialRoomState, { type: 'reset' });
    s = roomReducer(s, { type: 'presence', agents: [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null }] });
    s = roomReducer(s, { type: 'trace', agentId: 'ag_1', kind: 'thought', text: 'x' });
    s = roomReducer(s, { type: 'presence', agents: [{ agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null }] });
    expect(s.traces.ag_1).toBeUndefined();
  });
});
```

`apps/web/test/agent-panel.test.tsx` 新建：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPanel } from '../src/components/AgentPanel.js';

afterEach(cleanup);

const agents = [
  { agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: 800, score: null, mentioned: true },
  { agentId: 'ag_2', name: '老豆', status: 'online', latencyMs: null, score: null },
];

describe('AgentPanel traces 与徽章（2.2）', () => {
  it('mentioned 徽章 + 点击展开 traces', () => {
    render(
      <AgentPanel
        agents={agents as any}
        traces={{ ag_1: [{ kind: 'thought', text: '先想' }, { kind: 'tool', text: 'search()' }] }}
      />,
    );
    expect(screen.getByText('被点名')).toBeTruthy();
    expect(screen.queryByText('先想')).toBeNull(); // 未展开
    fireEvent.click(screen.getByText('小豆'));
    expect(screen.getByText('先想')).toBeTruthy();
    expect(screen.getByText('search()')).toBeTruthy();
  });
  it('无 traces 的 Agent 展开显示空态', () => {
    render(<AgentPanel agents={agents as any} traces={{}} />);
    fireEvent.click(screen.getByText('老豆'));
    expect(screen.getByText(/暂无上报/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/room-reducer.test.ts apps/web/test/agent-panel.test.tsx`
Expected: FAIL（traces 字段不存在 / AgentPanel 无 traces props）

- [ ] **Step 3: 实现**

`apps/web/src/room-reducer.ts`：`RoomState` 增 `traces: Record<string, Array<{ kind: string; text: string }>>`（initialRoomState 增 `traces: {}`）；`RoomAction` 增 trace 变体；switch 三处：

```ts
    case 'trace': {
      const list = [...(state.traces[action.agentId] ?? []), { kind: action.kind, text: action.text }].slice(-20);
      return { ...state, traces: { ...state.traces, [action.agentId]: list } };
    }
```

`message` case（agent 消息落库、清 streaming 处）同步删 `state.traces[sender.agentId]`（无 agentId 不动）；`presence` case 在清 streaming 的循环旁同样只保留 thinking Agent 的 traces。`ready`/`reset` 置 `traces: {}`。

`apps/web/src/useRoomSocket.ts` 的 `post_delta` 分支后追加：

```ts
        } else if (f.type === 'trace') {
          dispatch({ type: 'trace', agentId: f.agentId, kind: f.kind, text: f.text });
        }
```

`apps/web/src/components/AgentPanel.tsx`：props 增 `traces?: Record<string, Array<{ kind: string; text: string }>>`；组件内 `const [expanded, setExpanded] = useState<string | null>(null)`（`import { useState } from 'react'`）；行内 `mentioned` 时加 `<span className="tag">被点名</span>`；行点击 `onClick={() => setExpanded(expanded === a.agentId ? null : a.agentId)}`；行下方 `expanded === a.agentId` 时渲染：

```tsx
        <div className="agent-traces">
          {(traces?.[a.agentId]?.length ?? 0) === 0
            ? <div className="muted">暂无上报</div>
            : traces![a.agentId].map((t, i) => (
              <div className="trace-row" key={i}>
                <span className={`trace-kind trace-${t.kind}`}>{t.kind === 'thought' ? '思考' : '工具'}</span>
                <span>{t.text}</span>
              </div>
            ))}
        </div>
```

（AgentPanel 现有结构是 `.agent-row` 列表——traces 面板渲染在该行 row 容器内、紧跟状态信息之后；无 owner/kick 交互路径不受影响。）

`apps/web/src/pages/RoomPage.tsx`：AgentPanel 调用处加 `traces={replay ? undefined : state.traces}`。

`apps/web/src/index.css` 追加：

```css
/* ── Agent trace 面板（2.2）──────────── */
.agent-row { cursor: pointer; }
.agent-traces { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; padding: 8px 0 4px; border-top: 1px dashed var(--line); }
.trace-row { display: flex; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.trace-kind { flex: none; font-size: 10px; letter-spacing: .08em; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; height: fit-content; }
.trace-thought { color: var(--primary); border-color: var(--primary-soft); }
.trace-tool { color: var(--muted); }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): agent trace panel and mentioned badge"
```

---

### Task 6: 版本 2.1.0、CHANGELOG 与全量回归

**Files:**
- Modify: `package.json`（version → 2.1.0）
- Modify: `CHANGELOG.md`（顶部增 [2.1.0]）

- [ ] **Step 1: 版本与 CHANGELOG**

`package.json` 的 `"version"` 改为 `"2.1.0"`。

`CHANGELOG.md` 顶部（`## [2.0.0]` 之前）插入：

```markdown
## [2.1.0] - 2026-10-28

### 新增
- **Agent trace**：SDK `helpers.trace(kind, text)` 上报思考摘要（thought）/工具调用（tool）；直播间 Agent 面板点击展开查看；live-only 不落库（单 event ≤20 条）
- **「被点名」徽章**：被 @ 定向派发期间的 Agent 在面板显示点名状态

[2.1.0]: https://github.com/CChiaki/ai-smash/releases/tag/v2.1.0

```

- [ ] **Step 2: 全量回归与构建**

Run: `npx vitest run && npx playwright test && npm run build`
Expected: 全部通过（vitest 231+新增、e2e 9 条、构建成功）

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: agent trace and mention badge v2.1.0"
```

---

## 验收清单（2.2 完成标准）

1. `npx vitest run` 全绿；typecheck 全部工程干净；`npm run build` 成功；e2e 9 条全绿。
2. trace 语义与规格 §9.1 一致（live-only、stale 丢弃、≤20 条/event）；徽章与 §9.2 一致（仅 mention 在途期间 true）。
3. 回放无 trace、无 streaming（既有语义不回归）。
4. 版本 2.1.0；CHANGELOG [2.1.0] 就位。
