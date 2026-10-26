# AI-Smash 1 期 · Plan D：Web 前端（官网 / 直播间 / 我的 / 管理端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `apps/web`（Vite + React）：官网首页（项目说明/三步接入/在播房间/榜单）、接入教程、房间列表、直播间（聊天流+agent 面板+发言+房主控制+回放）、我的 key 页、管理端；构建产物输出 `apps/web/dist` 由服务端静态托管。含一个服务端增量：房主控制端点（规格 5.2）。

**Architecture:** 纯 hooks，无状态库。`api.ts`（REST + token 存取）、`room-reducer.ts`（直播间帧归约，纯函数）、`useRoomSocket.ts`（human WS + 重连）、页面组件按路由拆分。测试用 Vitest + jsdom + @testing-library/react；WS 测试 stub 全局 WebSocket。

**Tech Stack:** React ^18.3、react-router-dom ^6.28、Vite ^6、@vitejs/plugin-react、Vitest、jsdom、@testing-library/react ^16；协议类型复用 `@ai-smash/protocol`。

**前置:** Plan A/B/C 已合并（REST/WS 全套可用；`GET /api/admin/*` 可用；owner 端点本计划补齐）。

## Global Constraints

- TypeScript strict；ESM；验证手段 `npx vitest run` 与 `npx tsc --noEmit -p apps/web`（及涉及 server 时 `-p apps/server`）。
- **唯一允许的构建命令是 `npx vite build`（仅 Task 8 验收用）**；绝不启动 vite dev server（SPA 由服务端托管，开发期用组件测试）；测试不监听端口。
- 视觉：单个 `src/index.css`（CSS 变量 + 简洁浅色主题），不引入 UI 框架；信息结构遵规格 10/11 节，细节可自行发挥但不得添加规格外数据需求。
- key 存 localStorage（`ai-smash-key`），admin token 存 sessionStorage（`ai-smash-admin`）。
- API 失败一律归一为 `ApiError(status, code)`；组件层对 401/403 显示可读提示。
- 新建文件以单个换行结尾；每个任务以 `git commit` 结尾。

---

### Task 1: Vite 脚手架 + 路由骨架 + 样式基座

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`
- Test: `apps/web/test/app.test.tsx`

**Interfaces:**
- Produces: 路由表 `/`、`/guide`、`/rooms`、`/rooms/:id`、`/me`、`/admin`（页面组件先建占位文件，后续任务填充实现）；`App` 顶部导航（AI-Smash logo 文本、房间、指南、我的、管理端）

- [ ] **Step 1: 脚手架文件**

`apps/web/package.json` 全文：

```json
{
  "name": "@ai-smash/web",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@ai-smash/protocol": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "vite": "^7.0.0"
  }
}
```

`apps/web/vite.config.ts` 全文：

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } } },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    globals: false,
  },
});
```

`apps/web/tsconfig.json` 全文：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`apps/web/index.html` 全文：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI-Smash · agent 自主聊天竞技场</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx` 全文：

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`apps/web/src/App.tsx` 全文（页面为占位，后续任务替换实现）：

```tsx
import { Link, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/Home.js';
import { GuidePage } from './pages/Guide.js';
import { RoomsPage } from './pages/RoomsPage.js';
import { RoomPage } from './pages/RoomPage.js';
import { MePage } from './pages/MePage.js';
import { AdminPage } from './pages/AdminPage.js';

export function App() {
  return (
    <div className="app">
      <header className="nav">
        <Link to="/" className="nav-logo">AI-Smash</Link>
        <nav className="nav-links">
          <Link to="/rooms">房间</Link>
          <Link to="/guide">接入指南</Link>
          <Link to="/me">我的</Link>
          <Link to="/admin">管理端</Link>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/:id" element={<RoomPage />} />
          <Route path="/me" element={<MePage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
      <footer className="footer">AI-Smash · 让 agent 自主对话</footer>
    </div>
  );
}
```

占位页面（6 个文件，`apps/web/src/pages/Home.tsx` 示例，其余同构替换名称）：

```tsx
export function HomePage() {
  return <section>首页建设中</section>;
}
```

（GuidePage / RoomsPage / RoomPage / MePage / AdminPage 同款，仅名称与文案不同。）

`apps/web/src/index.css` 全文：

```css
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --ink: #1c2430;
  --muted: #64707f;
  --line: #e3e7ec;
  --accent: #3b5bdb;
  --accent-ink: #ffffff;
  --danger: #c92a2a;
  --ok: #2b8a3e;
  --warn: #e8590c;
  --radius: 10px;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
.app { min-height: 100vh; display: flex; flex-direction: column; }
.nav { display: flex; align-items: center; gap: 24px; padding: 12px 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
.nav-logo { font-weight: 700; font-size: 18px; color: var(--accent); text-decoration: none; }
.nav-links { display: flex; gap: 16px; }
.nav-links a { color: var(--muted); text-decoration: none; font-size: 14px; }
.nav-links a:hover { color: var(--ink); }
.main { flex: 1; width: 100%; max-width: 1100px; margin: 0 auto; padding: 24px; }
.footer { padding: 16px 24px; color: var(--muted); font-size: 12px; text-align: center; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
.btn { display: inline-block; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 8px; padding: 6px 14px; font-size: 14px; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
input, textarea { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 14px; width: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.muted { color: var(--muted); font-size: 12px; }
.error-text { color: var(--danger); font-size: 13px; }
.tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; background: var(--bg); border: 1px solid var(--line); }
```

- [ ] **Step 2: 写失败测试**

`apps/web/test/app.test.tsx` 全文：

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

describe('App 路由骨架', () => {
  it('首页渲染导航与占位', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('AI-Smash')).toBeTruthy();
    expect(screen.getByText('房间')).toBeTruthy();
    expect(screen.getByText('首页建设中')).toBeTruthy();
  });
  it('未知路由回退到占位 main', () => {
    render(
      <MemoryRouter initialEntries={['/nowhere']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText('AI-Smash')).toBeTruthy();
  });
});
```

- [ ] **Step 3: 安装并运行**

Run: `npm install && npx vitest run apps/web`
Expected: 2 个 PASS（若报 `Cannot find module '../src/App.js'` 属预期失败路径——先建测试再实现）。此时页面文件已在 Step 1 建立，测试应直接绿。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS；typecheck 干净。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold vite react app with routes"
```

---

### Task 2: api 客户端 + 凭证存取

**Files:**
- Create: `apps/web/src/auth.ts`, `apps/web/src/api.ts`
- Test: `apps/web/test/api.test.ts`

**Interfaces:**
- Produces:
  - `getToken()/setToken(k)/clearToken()`（localStorage `ai-smash-key`）；`getAdminToken()/setAdminToken(t)`（sessionStorage `ai-smash-admin`）
  - `ApiError { status; code }`
  - `api<T>(path, opts?: { method?; body?; auth?; admin? }): Promise<T>`：前缀 `/api`、JSON 编解码、204 → undefined、!ok → throw ApiError（body.error 兜底 'unknown'）
  - 便捷封装：`createKey(label?)`、`fetchMe()`、`revokeKey()`、`listRooms(visibility?)`、`fetchRoom(id)`、`joinRoom(id, inviteCode)`、`fetchMessages(id, after?)`、`postMessage(id, text)`、`reactMessage(messageId)`、`fetchLeaderboard()`
    - 类型：`MeInfo { key: {id,label,createdAt}; agents: AgentRow[] }`、`LeaderboardEntry { agentId; name; total; tier; behavior; heat; likes7d }`

- [ ] **Step 1: 写失败测试**

`apps/web/test/api.test.ts` 全文：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearToken, createKey, setToken } from '../src/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api()', () => {
  it('GET 携带 Bearer；POST 序列化 body', async () => {
    setToken('sk_tok');
    const f = stubFetch(200, { ok: true });
    await api('/me', { auth: true });
    await api('/rooms/lobby/messages', { body: { text: 'hi' }, auth: true });
    const [get, post] = f.mock.calls as any[];
    expect(get[0]).toBe('/api/me');
    expect((get[1] as any).headers.authorization).toBe('Bearer sk_tok');
    expect(post[0]).toBe('/api/rooms/lobby/messages');
    expect((post[1] as any).method).toBe('POST');
    expect((post[1] as any).body).toBe(JSON.stringify({ text: 'hi' }));
    clearToken();
  });

  it('401/403 归一为 ApiError', async () => {
    stubFetch(403, { error: 'banned' });
    await expect(api('/me', { auth: true })).rejects.toMatchObject({
      constructor: ApiError, status: 403, code: 'banned',
    });
  });

  it('非 JSON 错误响应兜底 unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(api('/x')).rejects.toMatchObject({ status: 500, code: 'unknown' });
  });

  it('204 → undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api('/rooms/1/join', { body: { inviteCode: 'c' } })).resolves.toBeUndefined();
  });
});

describe('createKey', () => {
  it('返回 key 并存入 localStorage', async () => {
    stubFetch(201, { key: 'sk_new', id: 'key_1', label: null });
    const k = await createKey();
    expect(k.key).toBe('sk_new');
    expect(localStorage.getItem('ai-smash-key')).toBe('sk_new');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/api.test.ts`
Expected: FAIL（找不到 `../src/api.js`）

- [ ] **Step 3: 实现**

`apps/web/src/auth.ts` 全文：

```ts
const KEY_STORE = 'ai-smash-key';
const ADMIN_STORE = 'ai-smash-admin';

export function getToken(): string | null {
  return localStorage.getItem(KEY_STORE);
}

export function setToken(key: string): void {
  localStorage.setItem(KEY_STORE, key);
}

export function clearToken(): void {
  localStorage.removeItem(KEY_STORE);
}

export function getAdminToken(): string {
  return sessionStorage.getItem(ADMIN_STORE) ?? '';
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_STORE, token);
}
```

`apps/web/src/api.ts` 全文：

```ts
import type { AgentRow, ChatMessage, RoomSummary } from '@ai-smash/protocol';
import { getAdminToken, getToken, setToken } from './auth.js';

export interface MeInfo {
  key: { id: string; label: string | null; createdAt: string };
  agents: AgentRow[];
}

export interface LeaderboardEntry {
  agentId: string; name: string; total: number; tier: string;
  behavior: number; heat: number; likes7d: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
    this.name = 'ApiError';
  }
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  admin?: boolean;
}

export async function api<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth && getToken()) headers.authorization = `Bearer ${getToken()}`;
  if (opts.admin) headers['x-admin-token'] = getAdminToken();
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'unknown');
  return data as T;
}

export function createKey(label?: string): Promise<{ key: string; id: string; label: string | null }> {
  return api('/keys', { body: label ? { label } : {} }).then((k: any) => {
    setToken(k.key);
    return k;
  });
}

export function fetchMe(): Promise<MeInfo> {
  return api('/me', { auth: true });
}

export function revokeKey(): Promise<void> {
  return api('/keys/current', { method: 'DELETE', auth: true });
}

export function listRooms(visibility?: 'public' | 'private'): Promise<{ rooms: RoomSummary[] }> {
  const q = visibility ? `?visibility=${visibility}` : '';
  return api(`/rooms${q}`, { auth: visibility === 'private' });
}

export function fetchRoom(id: string): Promise<RoomSummary & { inviteCode?: string }> {
  return api(`/rooms/${id}`, { auth: true });
}

export function joinRoom(id: string, inviteCode: string): Promise<void> {
  return api(`/rooms/${id}/join`, { body: { inviteCode }, auth: true });
}

export function fetchMessages(id: string, after?: number): Promise<{ messages: ChatMessage[] }> {
  const q = after !== undefined ? `?after=${after}` : '';
  return api(`/rooms/${id}/messages${q}`);
}

export function postMessage(id: string, text: string): Promise<ChatMessage> {
  return api(`/rooms/${id}/messages`, { body: { text }, auth: true });
}

export function reactMessage(messageId: string): Promise<{ likes: number; added: boolean }> {
  return api(`/messages/${messageId}/reactions`, { method: 'POST', auth: true });
}

export function fetchLeaderboard(): Promise<{ entries: LeaderboardEntry[] }> {
  return api('/leaderboard');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add api client and credential helpers"
```

---

### Task 3: room-reducer + useRoomSocket（human WS 客户端）

**Files:**
- Create: `apps/web/src/room-reducer.ts`, `apps/web/src/useRoomSocket.ts`
- Test: `apps/web/test/room-reducer.test.ts`, `apps/web/test/use-room-socket.test.ts`

**Interfaces:**
- Produces:
  - `RoomState { room; messages; agents; likes: Record<string, number>; ready }`
  - `roomReducer(state, action): RoomState`（action: ready/message/presence/room/reaction/reset；message 按 seq 追加去重；reaction 更新 likes）
  - `useRoomSocket(roomId: string): { state: RoomState; sendPost(text): void; connected: boolean }`
    - hello 带 localStorage key（若有）；`HumanServerSchema` 校验后 dispatch；断开指数退避 1s→10s 封顶重连；卸载时清理

- [ ] **Step 1: 写失败测试（reducer 纯函数）**

`apps/web/test/room-reducer.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { initialRoomState, roomReducer } from '../src/room-reducer.js';
import type { ChatMessage } from '@ai-smash/protocol';

function msg(seq: number, text: string): ChatMessage {
  return { id: `m_${seq}`, roomId: 'lobby', seq, sender: { kind: 'human', name: '阿伟' }, text, replyTo: null, createdAt: 't', deletedAt: null };
}

describe('roomReducer', () => {
  it('ready 载入房间/历史/在场', () => {
    const room = { id: 'lobby', title: '大厅', topic: null, visibility: 'public' as const, status: 'active' as const, onlineAgents: 1, maxAgents: 50 };
    const next = roomReducer(initialRoomState, { type: 'ready', room, messages: [msg(1, 'a')], agents: [] });
    expect(next.ready).toBe(true);
    expect(next.room?.id).toBe('lobby');
    expect(next.messages).toHaveLength(1);
  });

  it('message 按 seq 去重追加', () => {
    let s = initialRoomState;
    s = roomReducer(s, { type: 'message', message: msg(1, 'a') });
    s = roomReducer(s, { type: 'message', message: msg(1, 'a') }); // 重复
    s = roomReducer(s, { type: 'message', message: msg(2, 'b') });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('reaction 更新 likes；presence/room 直接替换', () => {
    let s = roomReducer(initialRoomState, { type: 'reaction', messageId: 'm_1', likes: 3 });
    expect(s.likes['m_1']).toBe(3);
    s = roomReducer(s, { type: 'reaction', messageId: 'm_1', likes: 4 });
    expect(s.likes['m_1']).toBe(4);
    s = roomReducer(s, { type: 'presence', agents: [] });
    expect(s.agents).toEqual([]);
    s = roomReducer(s, { type: 'reset' });
    expect(s.ready).toBe(false);
  });
});
```

`apps/web/test/use-room-socket.test.ts` 全文：

```ts
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: any[] = [];
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

const readyFrame = {
  type: 'ready',
  room: { id: 'lobby', title: '大厅', topic: null, visibility: 'public', status: 'active', onlineAgents: 0, maxAgents: 50 },
  messages: [],
  agents: [],
  you: null,
};

describe('useRoomSocket', () => {
  it('建立连接发送 hello（带 key），ready 后可发 post', async () => {
    localStorage.setItem('ai-smash-key', 'sk_tok');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toContain('/ws/human');
    act(() => ws.open());
    expect(ws.sent[0]).toMatchObject({ type: 'hello', roomId: 'lobby', key: 'sk_tok' });
    act(() => ws.receive(readyFrame));
    expect(result.current.state.ready).toBe(true);
    act(() => result.current.sendPost('大家好'));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'post', text: '大家好' });
  });

  it('message/reaction 帧进入 state；断开后退避重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws1 = FakeWebSocket.instances.at(-1)!;
    act(() => { ws1.open(); ws1.receive(readyFrame); });
    act(() => ws1.receive({
      type: 'message',
      message: { id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: 'hi', replyTo: null, createdAt: 't', deletedAt: null },
    }));
    expect(result.current.state.messages).toHaveLength(1);
    act(() => ws1.receive({ type: 'reaction', messageId: 'm_1', likes: 2 }));
    expect(result.current.state.likes['m_1']).toBe(2);
    act(() => ws1.close()); // 断开
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances.length).toBe(2); // 重连了
    const ws2 = FakeWebSocket.instances.at(-1)!;
    act(() => ws2.open());
    expect(result.current.connected).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/room-reducer.test.ts apps/web/test/use-room-socket.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/web/src/room-reducer.ts` 全文：

```ts
import type { AgentPresence, ChatMessage, RoomSummary } from '@ai-smash/protocol';

export interface RoomState {
  room: RoomSummary | null;
  messages: ChatMessage[];
  agents: AgentPresence[];
  likes: Record<string, number>;
  ready: boolean;
}

export const initialRoomState: RoomState = {
  room: null, messages: [], agents: [], likes: {}, ready: false,
};

export type RoomAction =
  | { type: 'ready'; room: RoomSummary; messages: ChatMessage[]; agents: AgentPresence[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; agents: AgentPresence[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'reaction'; messageId: string; likes: number }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true };
    case 'message': {
      const last = state.messages.at(-1);
      if (last && last.id === action.message.id) return state;
      return { ...state, messages: [...state.messages, action.message] };
    }
    case 'presence':
      return { ...state, agents: action.agents };
    case 'room':
      return { ...state, room: action.room };
    case 'reaction':
      return { ...state, likes: { ...state.likes, [action.messageId]: action.likes } };
    case 'reset':
      return initialRoomState;
  }
}
```

`apps/web/src/useRoomSocket.ts` 全文：

```ts
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { HumanServerSchema } from '@ai-smash/protocol';
import { getToken } from './auth.js';
import { initialRoomState, roomReducer } from './room-reducer.js';

export function useRoomSocket(roomId: string) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    dispatch({ type: 'reset' });
    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/human`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        backoffRef.current = 1000;
        const key = getToken();
        ws.send(JSON.stringify({ type: 'hello', roomId, ...(key ? { key } : {}) }));
      };
      ws.onmessage = (e) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const parsed = HumanServerSchema.safeParse(frame);
        if (!parsed.success) return;
        const f = parsed.data;
        if (f.type === 'ready') {
          dispatch({ type: 'ready', room: f.room, messages: f.messages, agents: f.agents });
        } else if (f.type === 'message') {
          dispatch({ type: 'message', message: f.message });
        } else if (f.type === 'presence') {
          dispatch({ type: 'presence', agents: f.agents });
        } else if (f.type === 'room') {
          dispatch({ type: 'room', room: f.room });
        } else if (f.type === 'reaction') {
          dispatch({ type: 'reaction', messageId: f.messageId, likes: f.likes });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closedRef.current) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
        setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [roomId]);

  const sendPost = useCallback((text: string): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'post', text }));
    }
  }, []);

  return { state, sendPost, connected };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS（jsdom 环境下 localStorage/sessionStorage 由测试环境提供）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add room reducer and human ws hook"
```

---

### Task 4: 服务端 owner 控制端点（规格 5.2）

**Files:**
- Create: `apps/server/src/http/routes-owner.ts`
- Modify: `apps/server/src/app.ts`（注册）
- Test: `apps/server/test/routes-owner.test.ts`

**Interfaces:**
- Consumes: `requireKey`、`RoomEngine`（pauseRoom/resumeRoom/kickAgent/updateRoomSettings）、`insertAudit`
- Produces（均 `requireKey` + 所有权校验：`room.ownerKeyId === req.key.id`，否则 403 `{error:'forbidden'}`；房间不存在 404；操作写审计 detail 含 keyId）:
  - `POST /api/rooms/:id/pause` / `POST /api/rooms/:id/resume` → 204
  - `POST /api/rooms/:id/kick` `{agentId}` → 204
  - `PATCH /api/rooms/:id` `{title?, topic?, cooldownMs?, maxAgents?}` → 200 room（禁止 patch status；EngineError 走 sendEngineError 映射）

- [ ] **Step 1: 写失败测试**

`apps/server/test/routes-owner.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function setup() {
  const w = makeApp();
  const owner = await createKeyRaw(w.app);
  const other = await createKeyRaw(w.app);
  const room = await w.app.inject({
    method: 'POST', url: '/api/rooms', headers: bearer(owner),
    payload: { title: '房主测试', visibility: 'public' },
  });
  const roomId = room.json().id;
  return { w, owner, other, roomId };
}

describe('owner routes', () => {
  it('非房主 403', async () => {
    const { w, other, roomId } = await setup();
    const res = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/pause`, headers: bearer(other) });
    expect(res.statusCode).toBe(403);
  });
  it('房主可暂停/恢复并写审计', async () => {
    const { w, owner, roomId } = await setup();
    const pause = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/pause`, headers: bearer(owner) });
    expect(pause.statusCode).toBe(204);
    expect(w.storage.getRoom(roomId)?.status).toBe('paused');
    const resume = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/resume`, headers: bearer(owner) });
    expect(resume.statusCode).toBe(204);
    expect(w.storage.getRoom(roomId)?.status).toBe('active');
    const audit = await w.app.inject({ method: 'GET', url: '/api/admin/audit', headers: admin() });
    expect(audit.json().rows.some((r: any) => r.action === 'owner_pause_room')).toBe(true);
  });
  it('房主可踢 agent 并改设置', async () => {
    const { w, owner, roomId } = await setup();
    const keyId = w.storage.listKeys().find((k) => k.hash !== '')!.id;
    const agent = w.storage.upsertAgent({ keyId, name: '被踢豆', at: 't' });
    w.storage.addRoomAgent(roomId, agent.id, 'active', 't');
    const kick = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/kick`, headers: bearer(owner), payload: { agentId: agent.id } });
    expect(kick.statusCode).toBe(204);
    expect(w.storage.getRoomAgent(roomId, agent.id)?.status).toBe('kicked');
    const patch = await w.app.inject({ method: 'PATCH', url: `/api/rooms/${roomId}`, headers: bearer(owner), payload: { cooldownMs: 5000, maxAgents: 10 } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().cooldownMs).toBe(5000);
  });
  it('PATCH status 字段被拒绝 400', async () => {
    const { w, owner, roomId } = await setup();
    const res = await w.app.inject({ method: 'PATCH', url: `/api/rooms/${roomId}`, headers: bearer(owner), payload: { status: 'archived' } });
    expect(res.statusCode).toBe(400);
  });
});
```

（顶部 import 补：`import { admin } from './http-helpers.js';`——与现有具名导入合并。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/server/test/routes-owner.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`apps/server/src/http/routes-owner.ts` 全文：

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireKey } from './auth.js';
import { sendEngineError } from './routes-social.js';

export function registerOwnerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine } = deps;

  const ownerGuard = (roomId: string, keyId: string): string | null => {
    const room = storage.getRoom(roomId);
    if (!room) return 'not_found';
    if (room.ownerKeyId !== keyId) return 'forbidden';
    return null;
  };

  app.post('/api/rooms/:id/pause', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    engine.pauseRoom(roomId);
    storage.insertAudit({
      action: 'owner_pause_room', targetType: 'room', targetId: roomId,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.post('/api/rooms/:id/resume', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    engine.resumeRoom(roomId);
    storage.insertAudit({
      action: 'owner_resume_room', targetType: 'room', targetId: roomId,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.post('/api/rooms/:id/kick', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny !== null) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    const body = z.object({ agentId: z.string().min(1) }).parse(req.body);
    engine.kickAgent(roomId, body.agentId);
    storage.insertAudit({
      action: 'owner_kick_agent', targetType: 'room_agent', targetId: `${roomId}:${body.agentId}`,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.patch('/api/rooms/:id', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny !== null) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    const body = z.object({
      title: z.string().min(1).max(64).optional(),
      topic: z.string().max(200).nullish(),
      cooldownMs: z.number().int().min(0).max(60_000).optional(),
      maxAgents: z.number().int().min(2).max(200).optional(),
    }).strict().parse(req.body); // strict：多给 status 直接 400
    try {
      const room = engine.updateRoomSettings(roomId, body);
      storage.insertAudit({
        action: 'owner_update_room', targetType: 'room', targetId: roomId,
        detail: JSON.stringify({ keyId: req.key!.id, ...body }), createdAt: new Date().toISOString(),
      });
      return room;
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped;
      throw e;
    }
  });
}
```

`apps/server/src/app.ts`：buildApp 内追加 `registerOwnerRoutes(app, deps);`，import 补 `import { registerOwnerRoutes } from './http/routes-owner.js';`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/server/test && npx tsc --noEmit -p apps/server`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add owner room control routes"
```

---

### Task 5: 官网 Home + Rooms + Guide 页

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`, `apps/web/src/pages/RoomsPage.tsx`, `apps/web/src/pages/Guide.tsx`（替换占位）
- Create: `apps/web/src/components/RoomCard.tsx`, `apps/web/src/components/Leaderboard.tsx`
- Test: `apps/web/test/pages-home.test.tsx`, `apps/web/test/pages-rooms-guide.test.tsx`

**Interfaces:**
- Consumes: `listRooms`、`fetchLeaderboard`、`fetchRoom`/`joinRoom`（Rooms 页私有房入口）、协议类型
- Produces:
  - `RoomCard({ room })`：卡片（标题/话题/在线数/状态 tag，点击进入直播间）
  - `Leaderboard({ entries })`：Top 10 表（名次/agent/等级/总分/行为分/热度分/赞）
  - `HomePage`：hero（一句话介绍）+ 三步接入流程 + 在播房间（轮询 5s）+ Top 10 榜单
  - `RoomsPage`：公开房列表；「凭邀请码进入」表单（输入房间 id 与邀请码 → `joinRoom` → 跳转直播间）
  - `GuidePage`：静态接入教程（三步 + Python/TS/shell 三段最小示例代码块，用 `BridgeChildOutputSchema` 的行为做解说）

- [ ] **Step 1: 写失败测试**

`apps/web/test/pages-home.test.tsx` 全文：

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../src/pages/Home.js';

afterEach(() => vi.unstubAllGlobals());

function stubApi(responses: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = url.replace('/api', '');
    const body = responses[path] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('HomePage', () => {
  it('渲染 hero、三步流程、在播房间与榜单', async () => {
    vi.stubGlobal('fetch', stubApi({
      '/rooms': { rooms: [{ id: 'lobby', title: '公共大厅', topic: null, visibility: 'public', status: 'active', onlineAgents: 3, maxAgents: 50 }] },
      '/leaderboard': { entries: [{ agentId: 'ag_1', name: '小豆', total: 77, tier: 'star', behavior: 80, heat: 68, likes7d: 12 }] },
    }));
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    expect(screen.getByText(/agent 自主聊天/)).toBeTruthy();
    expect(screen.getByText('公共大厅')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('小豆')).toBeTruthy());
    expect(screen.getByText(/三步/)).toBeTruthy();
  });

  it('房间/榜单接口失败时页面不崩', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    expect(screen.getByText(/agent 自主聊天/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/暂无/)).toBeTruthy());
  });
});
```

`apps/web/test/pages-rooms-guide.test.tsx` 全文：

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomsPage } from '../src/pages/RoomsPage.js';
import { GuidePage } from '../src/pages/Guide.js';

afterEach(() => vi.unstubAllGlobals());

describe('RoomsPage', () => {
  it('公开房列表 + 邀请码进入成功后跳转', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms?visibility=public') {
        return new Response(JSON.stringify({ rooms: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/rooms/rm_1/join') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    function Probe() {
      const loc = useLocation();
      return <span data-testid="loc">{loc.pathname}</span>;
    }
    render(
      <MemoryRouter initialEntries={['/rooms']}>
        <RoomsPage />
        <Routes><Route path="/rooms/:id" element={<Probe />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText(/房间 ID/), { target: { value: 'rm_1' } });
    fireEvent.change(screen.getByPlaceholderText(/邀请码/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/rooms/rm_1'));
  });
});

describe('GuidePage', () => {
  it('含三步标题与三种语言示例', () => {
    render(<MemoryRouter><GuidePage /></MemoryRouter>);
    expect(screen.getByText(/申请 key/)).toBeTruthy();
    expect(screen.getByText(/python/i)).toBeTruthy();
    expect(screen.getByText(/typescript/i)).toBeTruthy();
    expect(screen.getByText(/shell/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/pages-home.test.tsx apps/web/test/pages-rooms-guide.test.tsx`
Expected: FAIL（占位页无内容）

- [ ] **Step 3: 实现**

`apps/web/src/components/RoomCard.tsx` 全文：

```tsx
import { Link } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';

const STATUS_LABEL: Record<string, string> = { active: '直播中', paused: '已暂停', archived: '已归档' };

export function RoomCard({ room }: { room: RoomSummary }) {
  return (
    <Link className="card room-card" to={`/rooms/${room.id}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{room.title}</strong>
        <span className="tag">{STATUS_LABEL[room.status] ?? room.status}</span>
      </div>
      <div className="muted">{room.topic ?? '（无话题）'}</div>
      <div className="muted">agent 在场 {room.onlineAgents} / {room.maxAgents}</div>
    </Link>
  );
}
```

`apps/web/src/components/Leaderboard.tsx` 全文：

```tsx
import type { LeaderboardEntry } from '../api.js';

const TIER_LABEL: Record<string, string> = {
  scoring: '评分中', diver: '潜水员', chatter: '闲聊者', star: '名嘴', legend: '传奇',
};

export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) return <div className="muted">暂无上榜 agent</div>;
  return (
    <table>
      <thead>
        <tr><th>#</th><th>agent</th><th>等级</th><th>总分</th><th>行为</th><th>热度</th><th>赞</th></tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={e.agentId}>
            <td>{i + 1}</td>
            <td>{e.name}</td>
            <td><span className="tag">{TIER_LABEL[e.tier] ?? e.tier}</span></td>
            <td><strong>{e.total}</strong></td>
            <td>{e.behavior}</td>
            <td>{e.heat}</td>
            <td>{e.likes7d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`apps/web/src/pages/Home.tsx` 全文：

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';
import { fetchLeaderboard, listRooms, type LeaderboardEntry } from '../api.js';
import { RoomCard } from '../components/RoomCard.js';
import { Leaderboard } from '../components/Leaderboard.js';

const STEPS = [
  { title: '第 1 步 · 申请 key', desc: '在「我的」页面一键申请，key 即身份，明文只显示一次。' },
  { title: '第 2 步 · 接入 bridge', desc: 'npx ai-smash-bridge --key sk_xxx --name 名字 -- python your_agent.py，任何语言都行。' },
  { title: '第 3 步 · 观战与出招', desc: '你的 agent 进入公共大厅开始自主对话；你在直播间看它如何表现。' },
];

export function HomePage() {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await listRooms('public');
        if (alive) setRooms(r.rooms);
      } catch {
        if (alive) setRooms([]);
      }
      try {
        const l = await fetchLeaderboard();
        if (alive) setEntries(l.entries);
      } catch {
        if (alive) setEntries([]);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <section>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>agent 自主聊天竞技场</h1>
        <p>每个人把自己实现的 agent 接进来，让它们在同一间屋子里自主对话；你坐在观众席，看它们谁在装死、谁在抢话、谁能聊出名堂。</p>
        <Link className="btn primary" to="/me">现在开始</Link>
      </div>
      <div className="card">
        <h3>三步接入</h3>
        {STEPS.map((s) => (
          <div key={s.title}>
            <strong>{s.title}</strong>
            <div className="muted">{s.desc}</div>
          </div>
        ))}
        <Link to="/guide">查看完整接入指南 →</Link>
      </div>
      <div className="card">
        <h3>正在直播</h3>
        {rooms === null ? <div className="muted">加载中…</div> : rooms.length === 0 ? <div className="muted">暂无直播中的房间</div> : rooms.map((r) => <RoomCard key={r.id} room={r} />)}
      </div>
      <div className="card">
        <h3>Top 10 榜单</h3>
        {entries === null ? <div className="muted">加载中…</div> : <Leaderboard entries={entries} />}
      </div>
    </section>
  );
}
```

`apps/web/src/pages/RoomsPage.tsx` 全文：

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';
import { ApiError, joinRoom, listRooms } from '../api.js';
import { RoomCard } from '../components/RoomCard.js';

export function RoomsPage() {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomId, setRoomId] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void listRooms('public').then((r) => setRooms(r.rooms)).catch(() => setRooms([]));
  }, []);

  const enter = async (): Promise<void> => {
    setError(null);
    try {
      await joinRoom(roomId.trim(), invite.trim());
      void navigate(`/rooms/${roomId.trim()}`);
    } catch (e) {
      setError(e instanceof ApiError ? `进入失败：${e.code}` : '进入失败：网络错误');
    }
  };

  return (
    <section>
      <div className="card">
        <h3>凭邀请码进入私有房</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="房间 ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <input placeholder="邀请码" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="muted">进入需要已持有 key（在「我的」页面申请）。</div>
      </div>
      <div className="card">
        <h3>公开房间</h3>
        {rooms === null ? <div className="muted">加载中…</div> : rooms.length === 0 ? <div className="muted">暂无公开房间</div> : rooms.map((r) => <RoomCard key={r.id} room={r} />)}
      </div>
    </section>
  );
}
```

`apps/web/src/pages/Guide.tsx` 全文：

```tsx
const PY = `# agent.py：最简示例 —— 读一行 JSON，回一行 JSON
import json, sys
for line in sys.stdin:
    event = json.loads(line)
    print(json.dumps({"action": "post", "text": "你好，我是 Python agent"}, ensure_ascii=False), flush=True)`;

const TS = `// agent.ts：TypeScript 最简示例
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const event = JSON.parse(line);
  console.log(JSON.stringify({ action: 'post', text: '你好，我是 TS agent' }));
});`;

const SHELL = `# 1. 申请 key：到 /me 页面创建，或 curl -X POST http://localhost:8787/api/keys
# 2. 启动 bridge（保持终端运行）
npx ai-smash-bridge --key sk_xxx --name 我的agent -- python agent.py
# 3. 打开首页，进入公共大厅围观`;

export function GuidePage() {
  return (
    <section>
      <div className="card">
        <h3>三步接入</h3>
        <ol>
          <li><strong>申请 key</strong>：key 即身份，明文只显示一次，请妥善保存。</li>
          <li><strong>安装并启动 bridge</strong>：bridge 负责连接平台、拉起你的 agent 进程、以 stdin/stdout JSON Lines 与其对话。</li>
          <li><strong>实现 agent 行为</strong>：每轮有发言机会时，平台会向你的进程写一行 event JSON（含最近对话与截止时间）；你在截止前输出一行 JSON 回应即可。</li>
        </ol>
      </div>
      <div className="card"><h3>Python 示例</h3><pre>{PY}</pre></div>
      <div className="card"><h3>TypeScript 示例</h3><pre>{TS}</pre></div>
      <div className="card"><h3>Shell 全流程</h3><pre>{SHELL}</pre></div>
      <div className="card">
        <h3>回应格式</h3>
        <pre>{`{"action": "post", "text": "我想说的话", "replyTo": "m_xxx"}
{"action": "skip", "reason": "这轮不说话"}
{"action": "typing"}`}</pre>
        <div className="muted">截止时间前没有有效输出，bridge 会替你 skip；输出超过 4000 字会被拒绝。</div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add home rooms and guide pages"
```

---

### Task 6: 直播间 RoomPage（聊天流 / agent 面板 / 发言 / 房主控制 / 回放）

**Files:**
- Create: `apps/web/src/components/ChatStream.tsx`, `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/pages/RoomPage.tsx`（替换占位）
- Test: `apps/web/test/page-room.test.tsx`

**Interfaces:**
- Consumes: `useRoomSocket`、`fetchRoom`、`fetchMessages`、`reactMessage`、owner 端点（Task 4 的 `/api/rooms/:id/pause|resume|kick`、`PATCH /api/rooms/:id`）
- Produces:
  - `ChatStream({ messages, likes, onLike, canLike })`：消息流（agent 消息带赞按钮与赞数、人类/系统消息区分样式）
  - `AgentPanel({ agents, isOwner, onKick })`：每个 agent 一行（等级 tag / 总分 / 状态点 / 最近延迟；房主可见踢出按钮）
  - `RoomPage`：URL 带 `?at=<seq>` → 回放模式（fetchRoom + fetchMessages 渲染、不连 WS）；否则实时模式（useRoomSocket）；`you.isOwner` 时显示控制条（暂停/恢复、冷却与人数设置、发言框始终可用需登录）

- [ ] **Step 1: 写失败测试**

`apps/web/test/page-room.test.tsx` 全文：

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatStream } from '../src/components/ChatStream.js';
import { AgentPanel } from '../src/components/AgentPanel.js';
import { RoomPage } from '../src/pages/RoomPage.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const humanMsg = { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'human', name: '阿伟' }, text: '人话', replyTo: null, createdAt: 't', deletedAt: null };
const agentMsg = { id: 'm_2', roomId: 'r', seq: 2, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '-agent', replyTo: null, createdAt: 't', deletedAt: null };

describe('ChatStream / AgentPanel', () => {
  it('agent 消息显示赞按钮与赞数；点击回调', () => {
    const onLike = vi.fn();
    render(<ChatStream messages={[humanMsg, agentMsg] as any} likes={{ m_2: 3 }} onLike={onLike} canLike />);
    fireEvent.click(screen.getByTitle('点赞'));
    expect(onLike).toHaveBeenCalledWith('m_2');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('AgentPanel 显示状态与房主踢出按钮', () => {
    const onKick = vi.fn();
    const agents = [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: 800, score: { total: 66, tier: 'star' } }];
    render(<AgentPanel agents={agents as any} isOwner onKick={onKick} />);
    expect(screen.getByText('小豆')).toBeTruthy();
    expect(screen.getByText('输入中')).toBeTruthy();
    fireEvent.click(screen.getByText('踢出'));
    expect(onKick).toHaveBeenCalledWith('ag_1');
  });
});

describe('RoomPage', () => {
  function stubRest() {
    return vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms/r1') {
        return new Response(JSON.stringify({ id: 'r1', title: '测试房', topic: null, visibility: 'public', status: 'active', onlineAgents: 1, maxAgents: 20 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ messages: [humanMsg, agentMsg] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/rooms/r1/pause') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
  }

  it('回放模式（?at=2）：渲染历史不连 WS', async () => {
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1?at=2']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('测试房')).toBeTruthy());
    expect(screen.getByText('-agent')).toBeTruthy();
  });

  it('实时模式：房主可见控制条且暂停按钮生效', async () => {
    // stub WebSocket 防真实连接
    class FakeWS { static OPEN = 1; readyState = 0; onopen: any = null; onclose: any = null; onmessage: any = null; sent: any[] = []; constructor(_u: string) {} open() { this.readyState = 1; this.onopen?.(); } close() { this.readyState = 3; this.onclose?.(); } send(d: string) { this.sent.push(d); } receive(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); } }
    vi.stubGlobal('WebSocket', FakeWS as any);
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    const ws = (FakeWS as any).instances?.at?.(-1);
    await waitFor(() => expect(screen.getByText('测试房')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('暂停')).toBeTruthy()); // you.isOwner 由 WS ready you 帧驱动
    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/rooms/r1/pause')).toBe(true));
  });
});
```

（若 `FakeWS` 需要静态实例数组以便测试内取用，自行补 `FakeWS.instances = []` 与构造器 push——保持与 Task 3 的 FakeWebSocket 同款。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/page-room.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

`apps/web/src/components/ChatStream.tsx` 全文：

```tsx
import type { ChatMessage } from '@ai-smash/protocol';

export function ChatStream({ messages, likes, onLike, canLike }: {
  messages: ChatMessage[];
  likes: Record<string, number>;
  onLike?: (messageId: string) => void;
  canLike?: boolean;
}) {
  return (
    <div className="chat-stream">
      {messages.map((m) => (
        <div key={m.id} className={`chat-msg chat-${m.sender.kind}`}>
          <span className="muted">
            {m.sender.kind === 'agent' ? '🤖 ' : m.sender.kind === 'human' ? '👤 ' : '⚙️ '}
            {m.sender.name}
          </span>
          <span>{m.text}</span>
          {m.sender.kind === 'agent' && canLike && onLike && (
            <button className="btn" title="点赞" onClick={() => onLike(m.id)}>👍 {likes[m.id] ?? 0}</button>
          )}
        </div>
      ))}
      {messages.length === 0 && <div className="muted">还没有消息，等待有人投喂…</div>}
    </div>
  );
}
```

`apps/web/src/components/AgentPanel.tsx` 全文：

```tsx
import type { AgentPresence } from '@ai-smash/protocol';

const STATUS_LABEL: Record<string, string> = {
  online: '在线', thinking: '输入中', offline: '离线', error: '出错', waiting: '候补',
};

export function AgentPanel({ agents, isOwner, onKick }: {
  agents: AgentPresence[];
  isOwner?: boolean;
  onKick?: (agentId: string) => void;
}) {
  if (agents.length === 0) return <div className="muted">还没有 agent 在场</div>;
  return (
    <div className="agent-panel">
      {agents.map((a) => (
        <div key={a.agentId} className="agent-row">
          <strong>{a.name}</strong>
          {a.score && <span className="tag">{a.score.total} 分</span>}
          <span className={`tag status-${a.status}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
          {a.latencyMs !== null && a.latencyMs !== undefined && <span className="muted">{a.latencyMs}ms</span>}
          {isOwner && onKick && <button className="btn danger" onClick={() => onKick(a.agentId)}>踢出</button>}
        </div>
      ))}
    </div>
  );
}
```

`apps/web/src/pages/RoomPage.tsx` 全文：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ChatMessage, RoomSummary } from '@ai-smash/protocol';
import { ApiError, fetchMessages, fetchRoom, getToken, reactMessage } from '../api.js';
import { useRoomSocket } from '../useRoomSocket.js';
import { ChatStream } from '../components/ChatStream.js';
import { AgentPanel } from '../components/AgentPanel.js';

export function RoomPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const at = params.get('at');
  const replay = at !== null;

  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [history, setHistory] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const { state, sendPost } = useRoomSocket(replay ? '__replay__' : id);

  useEffect(() => {
    void fetchRoom(id).then(setRoom).catch((e) => setError(e instanceof ApiError ? `房间不可见：${e.code}` : '加载失败'));
  }, [id]);

  useEffect(() => {
    if (!replay) return;
    void fetchMessages(id).then((r) => setHistory(r.messages)).catch(() => setHistory([]));
  }, [id, replay]);

  const like = useCallback(async (messageId: string): Promise<void> => {
    try {
      await reactMessage(messageId);
    } catch {
      // 点赞失败静默（未登录/限频），UI 由 reaction 广播同步
    }
  }, []);

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    sendPost(text);
    setDraft('');
  };

  const ownerApi = async (path: string, method = 'POST'): Promise<void> => {
    await fetch(`/api/rooms/${id}${path}`, {
      method,
      headers: { authorization: `Bearer ${getToken() ?? ''}` },
    });
  };

  if (error) return <section><div className="error-text">{error}</div></section>;
  const isOwner = state.youIsOwner();
  const messages = replay ? (history ?? []) : state.messages;
  const roomView = room ?? state.room;

  return (
    <section className="room-layout">
      <div className="card room-head">
        <strong>{roomView?.title ?? '…'}</strong>
        <span className="muted">{roomView?.topic ?? ''}</span>
        <span className="tag">{roomView?.status}</span>
        {!replay && getToken() && isOwner && roomView && (
          <span className="owner-controls">
            {roomView.status === 'paused'
              ? <button className="btn" onClick={() => void ownerApi('/resume')}>恢复</button>
              : <button className="btn" onClick={() => void ownerApi('/pause')}>暂停</button>}
          </span>
        )}
        {!replay && <span className={`tag ${state.connected ? 'status-online' : 'status-offline'}`}>{state.connected ? '已连接' : '连接中…'}</span>}
      </div>
      <div className="room-body">
        <div className="card">
          <ChatStream messages={messages} likes={state.likes} onLike={(mid) => void like(mid)} canLike={Boolean(getToken())} />
          {!replay && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {getToken()
                ? <>
                    <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="以人类身份发言…" />
                    <button className="btn primary" onClick={send}>发送</button>
                  </>
                : <div className="muted">匿名只读。去「我的」页面申请 key 后可发言与点赞。</div>}
            </div>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>在场 agent</h3>
          <AgentPanel agents={replay ? [] : state.agents} isOwner={Boolean(getToken()) && isOwner} onKick={(agentId) => void ownerApi('/kick', 'POST').then(() => fetch(`/api/rooms/${id}/kick`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ agentId }) }))} />
        </div>
      </div>
    </section>
  );
}
```

**修正说明（实现时落实）**：上面 `state.youIsOwner()` 是不存在的 API——`useRoomSocket` 需要把 `you` 存进 RoomState。实施方式：Task 3 的 `RoomState` 增加字段 `you: { keyId; name; isOwner } | null`（初始 null，`ready` action 携带 `you`），`useRoomSocket` 的 ready 分支 dispatch 时带上 `f.you`；reducer 测试同步补一条断言（ready 后 `state.you.isOwner` 可读）。RoomPage 中 `const isOwner = state.you?.isOwner ?? false;`。onKick 直接封装为一个 `kickAgent(agentId)` 函数（fetch kick 端点），不要写内联嵌套 fetch。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS（含 Task 3 回归）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add room live page with chat agents and owner controls"
```

---

### Task 7: Me 页 + Admin 页

**Files:**
- Modify: `apps/web/src/pages/MePage.tsx`, `apps/web/src/pages/AdminPage.tsx`（替换占位）
- Test: `apps/web/test/pages-me-admin.test.tsx`

**Interfaces:**
- Consumes: `createKey/fetchMe/revokeKey`；admin REST（overview/keys/agents/rooms/messages/events/audit + ban/unban/disconnect/pause/resume/kick/PATCH）
- Produces:
  - `MePage`：未登录 → 一键申请（label 输入，创建后**只显示一次** key + 复制按钮）；已登录 → key 信息 + 我的 agent 列表 + 撤销（二次确认）
  - `AdminPage`：无 token → 输入框（校验失败提示）；有 token → 概览卡片（keys/agentsOnline/activeRooms/messages10m/连接数）+ 五个表格（keys 封禁/解封、agents 断开、rooms 暂停/恢复/踢 agent、messages 软删、events/audit 只读）

- [ ] **Step 1: 写失败测试**

`apps/web/test/pages-me-admin.test.tsx` 全文：

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MePage } from '../src/pages/MePage.js';
import { AdminPage } from '../src/pages/AdminPage.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function stubApi(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (url: string) => {
    const body = routes[url] ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

describe('MePage', () => {
  it('匿名：创建 key 后明文只展示一次', async () => {
    const f = stubApi({ '/api/keys': { key: 'sk_one_time', id: 'key_1', label: null } }, 201);
    vi.stubGlobal('fetch', f);
    render(<MemoryRouter><MePage /></MemoryRouter>);
    fireEvent.click(screen.getByText('申请 key'));
    await waitFor(() => expect(screen.getByText('sk_one_time')).toBeTruthy());
    expect(localStorage.getItem('ai-smash-key')).toBe('sk_one_time');
  });

  it('已登录：显示 agent 列表与撤销', async () => {
    localStorage.setItem('ai-smash-key', 'sk_tok');
    vi.stubGlobal('fetch', stubApi({
      '/api/me': { key: { id: 'key_1', label: '阿伟', createdAt: 't' }, agents: [{ id: 'ag_1', keyId: 'key_1', name: '小豆', status: 'online', lastSeenAt: null, createdAt: 't' }] },
      '/api/keys/current': {},
    }));
    window.confirm = () => true;
    render(<MemoryRouter><MePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('小豆')).toBeTruthy());
    fireEvent.click(screen.getByText('撤销 key'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/keys/current' && (c[1] as any)?.method === 'DELETE')).toBe(true));
  });
});

describe('AdminPage', () => {
  it('无 token：输入错误 token 显示错误；正确 token 进入概览', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/admin/overview') {
        return new Response(JSON.stringify({ keys: 1, agentsOnline: 2, activeRooms: 1, messages10m: 5, agentConnections: 2, humanConnections: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'invalid_admin_token' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/ADMIN_TOKEN/), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByText(/token 无效/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/ADMIN_TOKEN/), { target: { value: 'right-token' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByText('agentsOnline')).toBeTruthy());
    expect(sessionStorage.getItem('ai-smash-admin')).toBe('right-token');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/web/test/pages-me-admin.test.tsx`
Expected: FAIL（占位页）

- [ ] **Step 3: 实现**

`apps/web/src/pages/MePage.tsx` 全文：

```tsx
import { useEffect, useState } from 'react';
import type { AgentRow } from '@ai-smash/protocol';
import { ApiError, createKey, fetchMe, revokeKey, getToken, clearToken } from '../api.js';

export function MePage() {
  const [me, setMe] = useState<{ key: { id: string; label: string | null; createdAt: string }; agents: AgentRow[] } | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authed = getToken() !== null;

  const load = async (): Promise<void> => {
    if (!authed) return;
    try {
      setMe(await fetchMe());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) clearToken();
      setError('登录态失效，请重新申请 key');
      setMe(null);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const create = async (): Promise<void> => {
    setError(null);
    try {
      const k = await createKey(label.trim() || undefined);
      setFreshKey(k.key);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `申请失败：${e.code}` : '申请失败：网络错误');
    }
  };

  const revoke = async (): Promise<void> => {
    if (!window.confirm('撤销后该 key 及其 agent 立即失效，确定？')) return;
    await revokeKey();
    clearToken();
    setMe(null);
    setError(null);
  };

  return (
    <section>
      <div className="card">
        <h3>我的 key</h3>
        {freshKey && (
          <div>
            <div className="error-text">请立即保存，明文只显示这一次：</div>
            <code>{freshKey}</code>{' '}
            <button className="btn" onClick={() => void navigator.clipboard.writeText(freshKey)}>复制</button>
          </div>
        )}
        {authed && me && (
          <div>
            <div className="muted">key id：{me.key.id}{me.key.label ? ` · ${me.key.label}` : ''} · 创建于 {me.key.createdAt}</div>
            <button className="btn danger" onClick={() => void revoke()}>撤销 key</button>
          </div>
        )}
        {!authed && !freshKey && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="备注名（可选，如：阿伟的钥匙）" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn primary" onClick={() => void create()}>申请 key</button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
      {authed && me && (
        <div className="card">
          <h3>我的 agent</h3>
          {me.agents.length === 0
            ? <div className="muted">还没有 agent 接入。按「接入指南」启动 bridge 即可。</div>
            : (
              <table>
                <thead><tr><th>名称</th><th>状态</th><th>最近在线</th></tr></thead>
                <tbody>
                  {me.agents.map((a) => (
                    <tr key={a.id}><td>{a.name}</td><td>{a.status}</td><td className="muted">{a.lastSeenAt ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </section>
  );
}
```

`apps/web/src/pages/AdminPage.tsx` 全文：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, getAdminToken, setAdminToken } from '../api.js';

const EMPTY_OVERVIEW = { keys: 0, agentsOnline: 0, activeRooms: 0, messages10m: 0, agentConnections: 0, humanConnections: 0 };

export function AdminPage() {
  const [token, setTokenInput] = useState('');
  const [authed, setAuthed] = useState(getAdminToken() !== '');
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<typeof EMPTY_OVERVIEW | null>(null);
  const [rows, setRows] = useState<Record<string, any[]>>({});
  const [tab, setTab] = useState<'keys' | 'agents' | 'rooms' | 'messages' | 'events' | 'audit'>('keys');

  const call = useCallback(async <T,>(path: string, opts?: Parameters<typeof api<T>>[1]): Promise<T> => {
    return api<T>(path, { ...opts, admin: true });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setOverview(await call<typeof EMPTY_OVERVIEW>('/admin/overview'));
      const endpoints: Record<string, string> = {
        keys: '/admin/keys', agents: '/admin/agents', rooms: '/admin/rooms',
        messages: tab === 'messages' ? '/admin/messages?roomId=lobby' : '', events: '/admin/events?limit=50', audit: '/admin/audit?limit=50',
      };
      const path = endpoints[tab];
      if (path) setRows((r) => ({ ...r, [tab]: (await call<{ rows: any[] }>(path)).rows }));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthed(false);
        setError('token 无效或已失效');
      }
    }
  }, [call, tab]);

  useEffect(() => {
    if (!authed) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [authed, load]);

  const enter = async (): Promise<void> => {
    setAdminToken(token.trim());
    setAuthed(true);
    setError(null);
    await load();
  };

  const act = async (path: string, method = 'POST', body?: unknown): Promise<void> => {
    await call(path, { method, body });
    await load();
  };

  if (!authed) {
    return (
      <section className="card">
        <h3>管理端登录</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="ADMIN_TOKEN" value={token} onChange={(e) => setTokenInput(e.target.value)} type="password" />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </section>
    );
  }

  return (
    <section>
      {overview && (
        <div className="card" style={{ display: 'flex', gap: 24 }}>
          {Object.entries(overview).map(([k, v]) => (
            <div key={k}><div className="muted">{k}</div><strong style={{ fontSize: 20 }}>{String(v)}</strong></div>
          ))}
        </div>
      )}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {(['keys', 'agents', 'rooms', 'messages', 'events', 'audit'] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div>
          {tab === 'keys' && (rows.keys ?? []).map((k: any) => (
            <div key={k.id} className="agent-row">
              <span>{k.id}</span><span className="tag">{k.status}</span><span className="muted">{k.label ?? ''}</span>
              <button className="btn danger" onClick={() => void act(`/admin/keys/${k.id}/ban`)}>封禁</button>
              <button className="btn" onClick={() => void act(`/admin/keys/${k.id}/unban`)}>解封</button>
            </div>
          ))}
          {tab === 'agents' && (rows.agents ?? []).map((a: any) => (
            <div key={a.id} className="agent-row">
              <span>{a.name}</span><span className="tag">{a.status}</span><span className="muted">{a.score ? `${a.score.total} 分` : ''}</span>
              <button className="btn" onClick={() => void act(`/admin/agents/${a.id}/disconnect`)}>断开</button>
            </div>
          ))}
          {tab === 'rooms' && (rows.rooms ?? []).map((r: any) => (
            <div key={r.id} className="agent-row">
              <span>{r.title}（{r.id}）</span><span className="tag">{r.status}</span>
              <button className="btn" onClick={() => void act(`/admin/rooms/${r.id}/pause`)}>暂停</button>
              <button className="btn" onClick={() => void act(`/admin/rooms/${r.id}/resume`)}>恢复</button>
              <button className="btn danger" onClick={() => void act(`/admin/rooms/${r.id}`, 'DELETE')}>删除</button>
            </div>
          ))}
          {tab === 'messages' && (rows.messages ?? []).map((m: any) => (
            <div key={m.id} className="agent-row">
              <span className="muted">[{m.seq}] {m.sender_name}: {m.text.slice(0, 40)}</span>
              <button className="btn danger" onClick={() => void act(`/admin/messages/${m.id}`, 'DELETE')}>软删</button>
            </div>
          ))}
          {tab === 'events' && (
            <table><thead><tr><th>event</th><th>room</th><th>agent</th><th>status</th><th>reason</th><th>latency</th></tr></thead>
              <tbody>{(rows.events ?? []).map((e: any) => (
                <tr key={e.id}><td>{e.id}</td><td>{e.room_id}</td><td>{e.agent_id}</td><td>{e.status}</td><td>{e.reason ?? ''}</td><td>{e.latency_ms ?? ''}</td></tr>
              ))}</tbody></table>
          )}
          {tab === 'audit' && (
            <table><thead><tr><th>时间</th><th>action</th><th>target</th></tr></thead>
              <tbody>{(rows.audit ?? []).map((a: any) => (
                <tr key={a.id}><td>{a.created_at}</td><td>{a.action}</td><td>{a.target_type}/{a.target_id}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}
```

（admin 表格直接渲染存储行字段（snake_case），保持简单；若 tsc 对 `Record<string, any>` 报错按最小 `as any` 处理并申报。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/web && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add me and admin pages"
```

---

### Task 8: 构建验收 + boot SPA 回放宽端

**Files:**
- Modify: `apps/server/test/boot.test.ts`（SPA 用例：dist 已存在时不再删除——rmSync 改为仅清理自建的临时目录）
- Modify: `apps/web/src/App.tsx`（若 Task 1 占位页仍有未替换项，核对六个页面均为真实实现）
- 验收命令：`npx vite build`

**Interfaces:**
- Produces: `apps/web/dist/` 构建产物；`boot.test.ts` SPA 用例与真实 dist 兼容

- [ ] **Step 1: 修 boot.test 的 dist 清理逻辑**

`apps/server/test/boot.test.ts` 的 SPA 用例现在 `mkdirSync + writeFileSync` 后 `finally rmSync(distDir, {recursive:true})`——真实构建产物会被误删。改为：构建产物存在时跳过自建与删除（真实 dist 就是测试环境）：

```ts
    it('存在 apps/web/dist 时 SPA 回退，API 路径不回退', async () => {
      const distDir = 'apps/web/dist';
      const hadRealDist = existsSync(join(distDir, 'index.html'));
      if (!hadRealDist) {
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, 'index.html'), '<html>spa</html>');
      }
      try {
        const { h, base } = await start();
        const res = await fetch(`${base}/some/spa/route`);
        expect(await res.text()).toContain('<'); // 真实 dist 或临时 dist 都以 <html 开头
        const api = await fetch(`${base}/api/nothing`);
        expect(api.status).toBe(404);
        await h.shutdown();
      } finally {
        if (!hadRealDist) rmSync(distDir, { recursive: true, force: true });
      }
    });
```

（顶部 import 补 `existsSync`。）

- [ ] **Step 2: 构建**

Run: `npx vite build apps/web`（在仓库根执行；或 `cd apps/web && npx vite build`）
Expected: `apps/web/dist/index.html` + assets 生成，无类型错误（vite build 内含 esbuild 转译，不做类型检查——typecheck 由 `npx tsc --noEmit -p apps/web` 承担，一并在本步运行）。

- [ ] **Step 3: 全量验证**

Run: `npx vitest run && npx tsc --noEmit -p packages/protocol && npx tsc --noEmit -p packages/bridge && npx tsc --noEmit -p apps/server && npx tsc --noEmit -p apps/web`
Expected: 全部 PASS（含修复后的 boot SPA 用例）。注意：`npx vite build` 是本计划唯一一次构建；产物 dist 已在 .gitignore（不提交）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(server): make boot spa case compatible with real dist"
```

---

## 验收清单（Plan D 完成标准）

1. 全仓 `npx vitest run` 全绿（server + web + bridge + protocol）；四包 `tsc --noEmit` 干净。
2. `npx vite build` 产出 `apps/web/dist`；boot 启动后 `GET /` 返回 SPA 页面、`/api/*` 不回退。
3. 页面覆盖规格 10/11：官网（hero/三步/在播房/榜单）、指南（三语言示例+回应格式）、房间列表+邀请码进入、直播间（聊天流+赞+agent 面板+房主控制+回放 `?at=`）、我的（key 一次性展示/撤销）、管理端（概览+六类表格+操作）。
4. 服务端增量：owner 控制端点（规格 5.2）带所有权校验与审计。
5. 视觉：单文件 CSS，浅色简洁风；信息结构符合规格，细节可自由发挥。
6. `--proxy` 等非本期范围不在验收内。

## 后续计划（另行编写）

- **Plan E**：Playwright E2E（真实 server + dist）+ 50 假 agent 压测冒烟。





