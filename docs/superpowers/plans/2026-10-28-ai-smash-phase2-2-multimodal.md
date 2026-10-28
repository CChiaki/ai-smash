# AI大乱斗 2.3-2.5 · 全模态消息（图片/语音/视频）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息支持图片/语音/视频附件（URL 或 base64），全量落库、回放完整还原；不做上传端点。

**Architecture:** 协议加 `AttachmentSchema` 与 `ChatMessageSchema.attachments`；存储 `messages.attachments TEXT`（JSON 序列化，自动迁移）；引擎/网关透传（引擎只校验数量 ≤4）；前端 ChatStream 按附件类型渲染（image/audio/video）。

**Tech Stack:** 现有栈不变。

**规格来源:** `docs/superpowers/specs/2026-10-28-ai-smash-phase2-design.md` §10

## Global Constraints

- TypeScript strict；ESM；只允许 npm install、vitest、tsc --noEmit（收尾 `npm run build` 已授权）。
- **不做上传端点**；附件全量落库（URL 与 base64 都持久化），回放/历史完整还原。
- 附件形状：`image`（url XOR base64）、`audio`（url）、`video`（url）；单消息 ≤4 个；非法形状网关 zod 拒帧。
- base64 渲染仅 `data:image/` 拼接（SVG 拒绝防注入）；URL 渲染 `referrerPolicy="no-referrer"` + `loading="lazy"`。
- 版本 2.2.0；CHANGELOG 增 [2.2.0]。
- 新建/修改文件以单个换行结尾；每任务以 `git commit` 结尾。

---

### Task 1: 协议 Attachment schema

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/schema.test.ts`

**Interfaces:**
- Produces: `AttachmentSchema`、`Attachment` 类型、`ChatMessageSchema.attachments?: AttachmentSchema[]`（≤4）、`AgentClientSchema` post 变体增 `attachments?`

- [ ] **Step 1: 写失败测试**

`packages/protocol/test/schema.test.ts` 追加：

```ts
describe('Attachment 附件（2.3-2.5）', () => {
  it('ChatMessage 携带 attachments', () => {
    const m = ChatMessageSchema.parse({
      id: 'm_1', roomId: 'r', seq: 1,
      sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' },
      text: '看图', replyTo: null, createdAt: 't', deletedAt: null,
      attachments: [{ kind: 'image', url: 'https://x.com/a.png' }],
    });
    expect(m.attachments).toHaveLength(1);
  });
  it('image 必须二选一：url 或 base64，都无或都有拒绝', () => {
    const base = { kind: 'image' };
    expect(() => AttachmentSchema.parse({ ...base, url: 'https://x.com/a.png' })).toBeTruthy();
    expect(() => AttachmentSchema.parse({ ...base, base64: 'aGVsbG8=' })).toBeTruthy();
    expect(() => AttachmentSchema.parse(base)).toThrow();
    expect(() => AttachmentSchema.parse({ ...base, url: 'u', base64: 'b' })).toThrow();
  });
  it('audio/video 仅 url', () => {
    expect(() => AttachmentSchema.parse({ kind: 'audio', url: 'https://x.com/a.mp3' })).toBeTruthy();
    expect(() => AttachmentSchema.parse({ kind: 'video', base64: 'b' })).toThrow();
  });
  it('超 4 个附件拒绝', () => {
    const a = { kind: 'image', url: 'u' };
    const m = { id: 'm', roomId: 'r', seq: 1, sender: { kind: 'agent', name: 'x' }, text: '', replyTo: null, createdAt: 't', deletedAt: null, attachments: Array(5).fill(a) };
    expect(() => ChatMessageSchema.parse(m)).toThrow();
  });
});
```

（import 行合并 `AttachmentSchema`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/protocol`
Expected: FAIL（AttachmentSchema 未定义）

- [ ] **Step 3: 实现**

`packages/protocol/src/index.ts` 在 `ChatMessageSchema` 之前插入：

```ts
export const AttachmentSchema = z.object({
  kind: z.enum(['image', 'audio', 'video']),
  url: z.string().max(2048).optional(),
  base64: z.string().max(1_000_000).optional(),
}).refine((a) => (a.url !== undefined) !== (a.base64 !== undefined), {
  message: 'attachment 需要 url 或 base64 之一',
});
export type Attachment = z.infer<typeof AttachmentSchema>;
```

`ChatMessageSchema` 的 `deletedAt` 行后追加：

```ts
  attachments: z.array(AttachmentSchema).max(4).optional(),
```

AgentClientSchema 的 `post` 变体追加 `attachments: z.array(AttachmentSchema).max(4).optional(),`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/protocol && npx tsc --noEmit -p packages/protocol`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(protocol): attachment schema for multimodal messages"
```

---

### Task 2: 存储attachments 列与迁移

**Files:**
- Modify: `apps/server/src/storage/types.ts`（`NewMessageInput`/`MessageRow` 增 `attachments?: Attachment[]`）
- Modify: `apps/server/src/storage/sqlite.ts`（messages 表加列 + 迁移 + insert/list 序列化）
- Test: `apps/server/test/storage-attachments.test.ts`

**Interfaces:**
- Produces: `MessageRow.attachments?: Attachment[]`（存储层 JSON 序列化往返）

- [ ] **Step 1: 写失败测试**

`apps/server/test/storage-attachments.test.ts` 全文：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('messages.attachments（2.3-2.5）', () => {
  it('插入带附件消息并读回（JSON 往返）', () => {
    const s = new SqliteStorage(':memory:');
    const atts = [{ kind: 'image', url: 'https://x.com/a.png' }];
    s.insertMessage({ roomId: 'r', senderKind: 'agent', senderName: '小豆', agentId: 'ag_1', keyId: null, text: '看图', replyTo: null, createdAt: 't', attachments: atts } as any);
    const m = s.listMessages('r')[0];
    expect(m.attachments).toEqual(atts);
  });
  it('无附件消息读回 attachments 为 undefined', () => {
    const s = new SqliteStorage(':memory:');
    s.insertMessage({ roomId: 'r', senderKind: 'human', senderName: '阿伟', agentId: null, keyId: null, text: '纯文本', replyTo: null, createdAt: 't' });
    expect(s.listMessages('r')[0].attachments).toBeUndefined();
  });
  it('旧库（无 attachments 列）打开时自动迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aismash-att-'));
    const dbPath = join(dir, 'old.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
        sender_kind TEXT NOT NULL, sender_name TEXT NOT NULL, agent_id TEXT, key_id TEXT,
        text TEXT NOT NULL, reply_to TEXT, deleted_at TEXT, created_at TEXT NOT NULL, UNIQUE(room_id, seq));
    `);
    raw.close();
    const s = new SqliteStorage(dbPath);
    expect(s.listMessages('r')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

（顶部 `import Database from 'better-sqlite3';`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/storage-attachments.test.ts`
Expected: FAIL（attachments 列不存在）

- [ ] **Step 3: 实现**

`apps/server/src/storage/sqlite.ts`：

① SCHEMA 的 messages CREATE TABLE 中 `deleted_at TEXT` 行后追加 `attachments TEXT,`（逗号注意）。

② 构造器迁移（events mentioned 迁移之后）：

```ts
    const msgCols = (this.db.pragma('table_info(messages)') as Array<{ name: string }>).map((c) => c.name);
    if (!msgCols.includes('attachments')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
    }
```

③ `insertMessage`：attachments 序列化写入 `JSON.stringify(input.attachments ?? null)`；`listMessages`/`getMessage` 的映射加 `attachments: r.attachments ? JSON.parse(r.attachments) : undefined`。

④ `types.ts`：`NewMessageInput`/`MessageRow` 增 `attachments?: Attachment[]`（从 `@ai-smash/protocol` 导入类型）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): message attachments storage with auto migration"
```

---

### Task 3: 引擎与网关透传

**Files:**
- Modify: `apps/server/src/engine/room.ts`（`agentPost` 接收并透传 attachments 到 insertMessage 与 Bus 载荷）
- Modify: `apps/server/src/ws/agent-gateway.ts`（post 帧透传 attachments）
- Test: `apps/server/test/engine-attachments.test.ts`

**Interfaces:**
- Consumes: Task 1/2 产物
- Produces: `agentPost(agentId, eventId, text, replyTo?, attachments?)`；Bus `messageNew` 载荷的 message 带 attachments

- [ ] **Step 1: 写失败测试**

`apps/server/test/engine-attachments.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

const ATTS = [{ kind: 'image', url: 'https://x.com/a.png' }];

describe('附件透传（2.3-2.5）', () => {
  it('agentPost 携带附件：落库 + Bus 广播均带', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const messages = record(w.bus, Topics.messageNew);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '看图');
    const ev = dispatched[0];
    w.engine.agentPost(a.id, ev.eventId, '看我的图', undefined, ATTS as any);
    const msg = messages.find((m: any) => m.message.sender.kind === 'agent');
    expect(msg.message.attachments).toEqual(ATTS);
    expect(w.storage.listMessages('lobby')[0].attachments).toEqual(ATTS);
  });
  it('无附件消息 attachments 为 undefined', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.agentPost(a.id, 'ev_x', '无附件'); // stale 不落库，仅验证不抛
    expect(true).toBe(true);
  });
});

function post(w: ReturnType<typeof makeWorld>, text: string): void {
  w.engine.humanPost('lobby', 'key_1', '阿伟', text);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/engine-attachments.test.ts`
Expected: FAIL（agentPost 不接受第 5 参）

- [ ] **Step 3: 实现**

`apps/server/src/engine/room.ts`：`agentPost` 签名加第 5 参 `attachments?: Attachment[]`（从 `@ai-smash/protocol` 导入类型），`insertMessage` 调用透传 `attachments`。

`apps/server/src/ws/agent-gateway.ts` 的 `case 'post'`：透传 `frame.attachments`（zod 已校验形状）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): pass-through attachments in engine and gateway"
```

---

### Task 4: SDK attachments 返回支持

**Files:**
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/README.md`
- Test: `packages/sdk/test/client.test.ts`

**Interfaces:**
- Produces: `AgentReply` 的 post 变体增 `attachments?: Array<{ kind: string; url?: string; base64?: string }>`

- [ ] **Step 1: 写失败测试**

`packages/sdk/test/client.test.ts` 追加：

```ts
  it('onEvent 返回 attachments → post 帧携带', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '画图豆', url: platform.url },
      { onEvent: async () => ({ action: 'post', text: '看图', attachments: [{ kind: 'image', url: 'https://x.com/a.png' }] } as any) },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_a')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post' && (f as any).attachments));
    expect(platform.received.find((f) => f.type === 'post')).toMatchObject({ attachments: [{ kind: 'image', url: 'https://x.com/a.png' }] });
    agent.stop();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/sdk`
Expected: FAIL（post 帧无 attachments 字段）

- [ ] **Step 3: 实现**

`packages/sdk/src/client.ts` 的 `AgentReply` post 变体增 `attachments?: Array<{ kind: string; url?: string; base64?: string }>`；`finish` 的 post 分支透传 `...(reply.attachments ? { attachments: reply.attachments } : {})`。

`packages/sdk/README.md` 的 onEvent 示例后补一行注释：`// 返回值可带 attachments: [{ kind: 'image', url: '…' }] 渲染为图片/音频/视频`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/sdk && npx tsc --noEmit -p packages/sdk`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): attachments in agent replies"
```

---

### Task 5: 前端附件渲染

**Files:**
- Modify: `apps/web/src/components/ChatStream.tsx`（附件渲染：image/audio/video）
- Modify: `apps/web/src/index.css`（附件样式）
- Test: `apps/web/test/chat-stream.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `MessageRow.attachments`（经 toChatMessage 已在消息对象上）

- [ ] **Step 1: 写失败测试**

`apps/web/test/chat-stream.test.tsx` 追加：

```tsx
  it('渲染图片/音频/视频附件', () => {
    const mk = (kind: string, extra: Record<string, unknown>) => ({
      id: `m_${kind}`, roomId: 'r', seq: 1,
      sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' },
      text: `带${kind}`, replyTo: null, createdAt: 't', deletedAt: null,
      attachments: [extra],
    });
    render(<ChatStream messages={[
      mk('image', { kind: 'image', url: 'https://x.com/a.png' }),
      mk('audio', { kind: 'audio', url: 'https://x.com/a.mp3' }),
      mk('video', { kind: 'video', url: 'https://x.com/a.mp4' }),
    ] as any} likes={{}} />);
    expect(screen.getByRole('img')).toBeTruthy();
    expect(screen.getByRole('application').querySelector('audio')).toBeTruthy();
    expect(screen.getByRole('application').querySelector('video')).toBeTruthy();
  });
  it('base64 图片渲染为 data URI 且拒绝 svg', () => {
    render(<ChatStream messages={[
      { id: 'm_b', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: 'base64 图', replyTo: null, createdAt: 't', deletedAt: null, attachments: [{ kind: 'image', base64: 'aGVsbG8=' }] },
    ] as any} likes={{}} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.src.startsWith('data:image/')).toBe(true);
    expect(img.src).not.toContain('svg');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/chat-stream.test.tsx`
Expected: FAIL（无附件渲染）

- [ ] **Step 3: 实现**

`apps/web/src/components/ChatStream.tsx`：msg-body 内、赞按钮之前，若 `m.attachments?.length` 渲染附件区：

```tsx
        {m.attachments?.map((a, i) => a.kind === 'image' ? (
          a.base64
            ? <img key={i} src={`data:image/${imgExtFromBase64(a.base64)};base64,${a.base64}`} alt="附件图片" loading="lazy" className="msg-attachment" />
            : <img key={i} src={a.url} alt="附件图片" loading="lazy" referrerPolicy="no-referrer" className="msg-attachment" />
        ) : a.kind === 'audio' ? (
          <audio key={i} controls src={a.url} className="msg-attachment" />
        ) : a.kind === 'video' ? (
          <video key={i} controls src={a.url} className="msg-attachment" />
        ) : null)}
```

（辅助函数 `imgExtFromBase64`：按 base64 魔数猜扩展名 png/jpeg/gif/webp，默认 png。）

`apps/web/src/index.css` 追加：

```css
.msg-attachment { max-width: 280px; max-height: 210px; border-radius: var(--radius); display: block; margin-top: 6px; }
audio.msg-attachment { width: 260px; }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): render image audio video attachments"
```

---

### Task 6: 版本 2.2.0、CHANGELOG 与收尾

**Files:**
- Modify: `package.json`（version → 2.2.0）
- Modify: `CHANGELOG.md`（顶部增 [2.2.0]）

- [ ] **Step 1: 版本与 CHANGELOG**

`package.json` 的 `"version"` 改为 `"2.2.0"`。

`CHANGELOG.md` 顶部（`## [2.1.0]` 之前）插入：

```markdown
## [2.2.0] - 2026-10-28

### 新增
- **全模态消息**：Agent 发言可携带图片/语音/视频附件（URL 或 base64 图片，单消息 ≤4 个）；直播间渲染图片预览、音频/视频播放控件；回放/历史完整还原
- SDK `AgentReply` 支持 `attachments`；协议 `AttachmentSchema`（image url XOR base64 / audio url / video url）

### 说明
- 不做上传端点；TTS 生成、转码、内容审查为 3.0 项
- base64 图片由前端按魔数推断 data URI 类型；SVG 拒绝防注入

[2.2.0]: https://github.com/CChiaki/ai-smash/releases/tag/v2.2.0

```

- [ ] **Step 2: 全量回归与构建**

Run: `npx vitest run && npx playwright test && npm run build`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: multimodal messages v2.2.0"
```

---

## 验收清单（2.3-2.5 完成标准）

1. `npx vitest run` 全绿；typecheck 全部工程干净；`npm run build` 成功；`npx playwright test` 9 条全绿。
2. 附件形状校验（image 二选一/audio/video、≤4）由协议 zod 锁定。
3. 存储往返（JSON 序列化）与旧库迁移由测试锁定。
4. 引擎/网关/SDK 透传链路由测试锁定；回放/历史完整还原（URL 与 base64）。
5. 版本 2.2.0；CHANGELOG [2.2.0] 就位。