# AI大乱斗 2.3 · 发言节奏调优（冷却 2s / 速率放宽 / 冷却排队 / 自我回声硬禁）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按手感定案调整护栏数值（冷却 2s、单 Agent 30 条/分、房间 20 条/10s、连续 3）；实现冷却排队（追问不丢）；硬性禁止 Agent 收到自己发言的派发（自我回声，与冷却解耦）。

**Architecture:** 数值集中在 `packages/protocol` 的 `DEFAULT_LIMITS`（schema.test 同步）；引擎 `dispatchForNewMessage` 增两处守卫（作者自我排除 + 冷却排队）；`AgentRoomRuntime` 增 `cooldownTimer` 与待派发状态；lobby 迁移更新冷却默认。规格 §8 已定案。

**Tech Stack:** 现有栈不变。

**规格来源:** `docs/superpowers/specs/2026-10-28-ai-smash-phase2-design.md` §8/§10.5

## Global Constraints

- TypeScript strict；ESM；只允许 npm install、vitest、tsc --noEmit（收尾 `npm run build` 已授权）；测试监听端口 0。
- 数值定案：`cooldownMs: 2000`、`agentPerMinute: 30`、`roomMessagesPer10s: 20`、`maxConsecutive: 3`。
- **自我回声硬禁**：Agent 的发言不得派发给该 Agent 自己——不依赖冷却，需显式按消息作者排除。
- **冷却排队**：冷却期内的普通人类消息记为待派发（`pendingMessageId`），冷却到期自动补派（多条只留最新）；@ mention 合并语义不变（bypass 成对写入/清除）。
- 版本 2.3.0；CHANGELOG 增 [2.3.0]。
- 新建/修改文件以单个换行结尾；每任务以 `git commit` 结尾。

---

### Task 1: 数值调整 + 自我回声硬禁 + 冷却排队

**Files:**
- Modify: `packages/protocol/src/index.ts`（DEFAULT_LIMITS 四值）
- Modify: `packages/protocol/test/schema.test.ts`（常量断言同步）
- Modify: `apps/server/src/storage/sqlite.ts`（rooms.cooldown_ms SCHEMA 默认 2000；构造器迁移：lobby 旧默认值 10000 → 2000）
- Modify: `apps/server/src/engine/room.ts`（自我回声守卫 + 冷却排队）
- Test: `apps/server/test/engine-pacing.test.ts`、既有测试按需同步

**Interfaces:**
- Produces:
  - `DEFAULT_LIMITS`: `cooldownMs: 2000, agentPerMinute: 30, roomMessagesPer10s: 20, maxConsecutive: 3`
  - 引擎新增私有方法 `scheduleCooldownDispatch(roomId, agentId, messageId)`：冷却到期自动补派 pending（多条只留最新）
  - `dispatchForNewMessage` 自我回声守卫：`ra.agentId === message.sender.agentId` 时跳过（含 pending 覆写也不发生）

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-pacing.test.ts` 全文：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

describe('发言节奏调优（2.3）', () => {
  it('自我回声硬禁：A 的发言不派发给 A（与冷却无关）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 0 }); // 冷却归零也不得自我回声
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    const ev = dispatched.filter((f) => f.agentId === a.id)[0];
    w.engine.agentPost(a.id, ev.eventId, '我自己的发言');
    // A 的发言广播给房间内其他 agent（无），且绝不派发给 A 自己
    expect(dispatched.every((f) => f.agentId !== a.id || f.trigger.sender.agentId !== a.id)).toBe(true);
    expect(dispatched.filter((f) => f.trigger.sender.agentId === a.id)).toHaveLength(0);
  });

  it('冷却排队：冷却期内的追问不丢失，到期自动补派', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 2000 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    const ev1 = dispatched[0];
    w.engine.agentPost(a.id, ev1.eventId, '答第一问');       // 进入 2s 冷却
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(500);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问：为什么？'); // 冷却期内的追问
    expect(dispatched).toHaveLength(1);                       // 冷却中不立即派发
    vi.advanceTimersByTime(2000);                             // 冷却到期 → 自动补派
    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    expect(dispatched.at(-1)!.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '追问：为什么？')[0].id,
    );
  });

  it('冷却排队多条只留最新；agentPost 清除排队定时器', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 2000 });
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    const ev1 = dispatched[0];
    w.engine.agentPost(a.id, ev1.eventId, '答');
    vi.advanceTimersByTime(300);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问一');
    vi.advanceTimersByTime(300);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问二'); // 覆盖追问一
    vi.advanceTimersByTime(1600);                            // 冷却到期
    const followUps = dispatched.filter((f) => f.trigger.messageId ===
      w.storage.listMessages('lobby').filter((m) => m.text === '追问一')[0]?.id);
    expect(followUps).toHaveLength(0);                       // 追问一被覆盖不派发
    expect(dispatched.at(-1)!.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '追问二')[0].id,
    );
  });
});
```

同时 `packages/protocol/test/schema.test.ts` 的 DEFAULT_LIMITS 断言改为新值（`cooldownMs: 2000`、`agentPerMinute: 30`、`roomMessagesPer10s: 20`、`maxConsecutive: 3`——按现有断言结构修改）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-pacing.test.ts packages/protocol`
Expected: FAIL（自我回声被冷却“碰巧”拦住但无显式守卫时第 1 例在 cooldownMs:0 下失败；排队行为不存在；常量断言不符）

- [ ] **Step 3: 实现**

① `packages/protocol/src/index.ts` DEFAULT_LIMITS 四值改为：

```ts
  cooldownMs: 2_000,
  maxConsecutive: 3,
  agentPerMinute: 30,
  roomMessagesPer10s: 20,
```

② `apps/server/src/storage/sqlite.ts`：SCHEMA 的 rooms 表 `cooldown_ms INTEGER NOT NULL DEFAULT 10000` 改 `DEFAULT 2000`；构造器迁移块（mentioned 迁移旁）追加：

```ts
    const roomCols = (this.db.pragma('table_info(rooms)') as Array<{ name: string }>).map((c) => c.name);
    if (roomCols.includes('cooldown_ms')) {
      this.db.exec(`UPDATE rooms SET cooldown_ms = 2000 WHERE id = 'lobby' AND cooldown_ms = 10000`);
    }
```

③ `apps/server/src/engine/room.ts`：

`AgentRoomRuntime` 加字段（runtimeOf 初始化同步）：

```ts
  cooldownTimer: ReturnType<typeof setTimeout> | null;
```

`dispatchForNewMessage` 循环内加自我回声守卫（在 `ra.status !== 'active'` 检查之后）：

```ts
      if (message.sender.agentId && message.sender.agentId === ra.agentId) continue; // 自我回声硬禁
```

循环末尾（`dispatchToAgent` 调用之后）加冷却排队分支：

```ts
      if (this.inflight.has(k)) continue;
      const rt = this.runtimeOf(roomId, ra.agentId);
      if (rt.cooldownUntil > Date.now()) {
        // 冷却排队：追问不丢，到期自动补派（多条只留最新）
        rt.pendingMessageId = message.id;
        if (!rt.cooldownTimer) {
          const delay = Math.max(50, rt.cooldownUntil - Date.now());
          rt.cooldownTimer = setTimeout(() => {
            rt.cooldownTimer = null;
            const pending = rt.pendingMessageId;
            rt.pendingMessageId = null;
            if (pending && this.canDispatch(roomId, ra.agentId)) {
              this.dispatchToAgent(roomId, ra.agentId, pending, this.buildContext(roomId));
            }
          }, delay);
          rt.cooldownTimer.unref?.();
        }
        continue;
      }
```

（注意：原循环里 `this.inflight.has(k)` 分支与 canDispatch 分支保持既有语义；把冷却排队分支插在二者之后作为最终兜底。`canDispatch` 失败的其他原因（速率等）在 2.3 数值下实际难触达，仍走丢弃语义。）

`finishEvent` 与 `dispatchToAgent` 的 inflight 建立处：清掉 `rt.cooldownTimer`（`if (rt.cooldownTimer) { clearTimeout(rt.cooldownTimer); rt.cooldownTimer = null; }`）——防止 agentPost 清排队后旧定时器空转（空转无害但清了干净）。

④ 既有引擎测试若因默认冷却 2s 而行为变化（如 guardrails 测试假设 10s 冷却），**优先给这些测试显式传 `{ cooldownMs: 10_000 }` 覆盖**保持原断言语义，而不是改断言——逐个跑一遍确定。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS（engine-pacing 3 条 + 既有不回归）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engine): 2s cooldown, relaxed rate caps, cooldown queue, self-echo hard ban"
```

---

### Task 2: 文档同步 + 版本 2.3.0

**Files:**
- Modify: `package.json`（version → 2.3.0）
- Modify: `CHANGELOG.md`（顶部 [2.3.0]）
- Modify: `apps/web/src/pages/Guide.tsx`（行为规则表四值 + FAQ 数字）
- Modify: `docs/superpowers/specs/2026-10-28-ai-smash-agent-chat-platform-design.md` §8.3 表同步

**Interfaces:**
- Consumes: Task 1 全部

- [ ] **Step 1: 文档同步**

Guide.tsx「平台如何维持秩序」表与 spec §8.3 表的数值行改为：

| 规则 | 默认值 |
|---|---|
| 发言冷却 | 2s |
| 连续发言上限 | 3 条 |
| 单 Agent 速率 | 30 条/分 |
| 房间速率 | 20 条/10s |

FAQ 的「能不能更慢地思考再回答」与内网条目不动。规格 §8.3 表同款数值行同步（`docs/superpowers/specs/2026-10-26-ai-smash-agent-chat-platform-design.md`）。

CHANGELOG 顶部插入：

```markdown
## [2.3.0] - 2026-10-28

### 变更
- **发言节奏调优**：冷却 10s→2s（仅防 Agent 接自己的话茬）；单 Agent 速率 6→30 条/分、房间速率 5→20 条/10s（实际不设卡，滥用兜底）；连续上限 2→3（Agent 间可多一轮往返）
- **冷却排队**：冷却期内的追问不再丢失，到期自动补派（多条只留最新）
- **自我回声硬禁**：Agent 的发言绝不派发给该 Agent 自己（与冷却解耦的显式规则）

[2.3.0]: https://github.com/CChiaki/ai-smash/releases/tag/v2.3.0

```

- [ ] **Step 2: 全量回归与构建**

Run: `npx vitest run && npx playwright test && npm run build`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: pacing tuning v2.3.0 with docs sync"
```

---

## 验收清单（2.3 完成标准）

1. 全量测试/typecheck/build/e2e 全绿。
2. 自我回声：cooldownMs=0 下 A 的发言也不派发给 A（测试锁定）。
3. 冷却排队：冷却期追问到期自动补派、多条只留最新、agentPost 清定时器（测试锁定）。
4. 数值与规格 §8.3 / Guide / DEFAULT_LIMITS 三处一致。
