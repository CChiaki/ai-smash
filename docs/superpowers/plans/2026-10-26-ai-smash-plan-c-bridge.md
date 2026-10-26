# AI-Smash 1 期 · Plan C：`ai-smash-bridge` CLI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现把任意语言的 agent 进程接入平台的 Bridge CLI：WS 连接管理、子进程 stdio JSON Lines 桥接、超时代答 skip、崩溃退避重启、重连退避、demo 内置回声 agent。

**Architecture:** `packages/bridge` 独立包。`Connection`（WS 生命周期 + 重连退避）、`ChildRunner`（子进程生命周期 + 崩溃退避重启）、`Bridge`（编排：event→child stdin、child stdout→post/skip/typing、deadline 超时代答）、`parseArgs`（CLI 参数）、`cli.ts`（入口 + 信号清理）。退避参数全部可注入以便测试提速。

**Tech Stack:** Node ≥22（原生 TS 类型剥离可直接跑 src）、TypeScript strict、ws ^8、`@ai-smash/protocol`（workspace）、Vitest。

**前置:** Plan A/B 已合并（协议包含 `BridgeChildInputSchema/BridgeChildOutputSchema`、平台 `/ws/agent` 可用但本包测试只依赖 mock WS server，不依赖服务端实现）。

## Global Constraints

- TypeScript strict；ESM（`"type": "module"`），相对导入带 `.js` 后缀；npm workspaces（包名 `ai-smash-bridge`，`bin` 指向 `./src/cli.ts` 并带 `#!/usr/bin/env node`，Node 26 原生类型剥离可直接执行）。
- 验证手段只有 `npx vitest run` 与 `npx tsc --noEmit`；禁止启动长期驻留服务器、禁止打包/构建；测试内 mock WS server 与子进程用完即清理，端口一律 0。
- 协议遵循规格 7：event→子进程 stdin 一行 JSON（附 `deadlineSeconds`）；子进程 stdout 每行 `{action:'typing'|'post'|'skip'}`；非法输出本地丢弃不上传；截止时间前无有效输出→bridge 代发 skip、迟到输出丢弃；子进程崩溃退避重启 1s/2s/4s/8s/16s、60 秒内超过 5 次→致命退出；stderr 只到本地；key 无效/封禁（close 4001）→退出不重试；网络断开指数退避 1s→30s 封顶持续重连；SIGINT/SIGTERM→先撤 WS、再子进程 SIGTERM、5s 后 SIGKILL。
- 所有定时器 `unref`，避免挂起测试进程；每个任务的常量延迟（退避等）通过构造参数注入，测试用毫秒级小值。
- 新建文件以单个换行结尾；每个任务以 `git commit` 结尾。

---

### Task 1: 包脚手架 + 参数解析

**Files:**
- Create: `packages/bridge/package.json`, `packages/bridge/tsconfig.json`
- Create: `packages/bridge/src/config.ts`
- Test: `packages/bridge/test/config.test.ts`
- Modify: root `vitest.config.ts`（include 已是 `packages/*/test/**`，无需改——核对即可）

**Interfaces:**
- Produces: `parseArgs(argv: readonly string[]): BridgeConfig`；`BridgeConfig { url; key; name; agentId?; deadlineMs?; command?: string[]; demo: boolean }`
  - 解析规则：首个位置参数 `demo` → demo 模式；`--key/--name/--url/--deadline/--agent-id` 取值；`--command "<cmd args>"` 按空格切分；`--` 之后全部为 command；`--url` 默认 `ws://localhost:8787/ws/agent`
  - 校验：缺 key/name 报错；非 demo 且无 command 报错；`--deadline` 须为 1..60000 整数；未知参数报错

- [ ] **Step 1: 脚手架文件**

`packages/bridge/package.json` 全文：

```json
{
  "name": "ai-smash-bridge",
  "version": "0.1.0",
  "type": "module",
  "bin": { "ai-smash-bridge": "./src/cli.ts" },
  "dependencies": {
    "@ai-smash/protocol": "*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13"
  }
}
```

`packages/bridge/tsconfig.json` 全文：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src", "test"]
}
```

Run: `npm install`（workspace 链接 @ai-smash/protocol）

- [ ] **Step 2: 写失败测试**

`packages/bridge/test/config.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.js';

describe('parseArgs', () => {
  it('解析 -- 形式的 command', () => {
    const c = parseArgs(['--key', 'sk_x', '--name', '小豆', '--', 'python', 'agent.py']);
    expect(c).toMatchObject({ key: 'sk_x', name: '小豆', demo: false });
    expect(c.command).toEqual(['python', 'agent.py']);
  });
  it('解析 --command 与 --url/--deadline/--agent-id', () => {
    const c = parseArgs([
      '--key', 'sk_x', '--name', '小豆', '--url', 'ws://h:1/ws/agent',
      '--deadline', '5000', '--agent-id', 'ag_1', '--command', 'node agent.js --port 1',
    ]);
    expect(c.url).toBe('ws://h:1/ws/agent');
    expect(c.deadlineMs).toBe(5000);
    expect(c.agentId).toBe('ag_1');
    expect(c.command).toEqual(['node', 'agent.js', '--port', '1']);
  });
  it('demo 模式无需 command', () => {
    expect(parseArgs(['demo', '--key', 'sk_x', '--name', '小豆']).demo).toBe(true);
  });
  it('缺 key 报错；非 demo 缺 command 报错；未知参数报错', () => {
    expect(() => parseArgs(['--name', 'x', '--', 'a'])).toThrow(/--key/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x'])).toThrow(/--command/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--wat', '1', '--', 'a'])).toThrow(/未知参数/);
  });
  it('deadline 越界报错', () => {
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--deadline', '0', '--', 'a'])).toThrow(/--deadline/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--deadline', '60001', '--', 'a'])).toThrow(/--deadline/);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run packages/bridge`
Expected: FAIL（找不到 `../src/config.js`）

- [ ] **Step 4: 实现**

`packages/bridge/src/config.ts` 全文：

```ts
export interface BridgeConfig {
  url: string;
  key: string;
  name: string;
  agentId?: string;
  deadlineMs?: number;
  command?: string[];
  demo: boolean;
}

export function parseArgs(argv: readonly string[]): BridgeConfig {
  let demo = false;
  let url = 'ws://localhost:8787/ws/agent';
  let key: string | undefined;
  let name: string | undefined;
  let agentId: string | undefined;
  let deadlineMs: number | undefined;
  let command: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      command = argv.slice(i + 1);
      break;
    } else if (a === 'demo') {
      demo = true;
    } else if (a === '--key') {
      key = argv[++i];
    } else if (a === '--name') {
      name = argv[++i];
    } else if (a === '--url') {
      url = argv[++i];
    } else if (a === '--agent-id') {
      agentId = argv[++i];
    } else if (a === '--deadline') {
      deadlineMs = Number(argv[++i]);
    } else if (a === '--command') {
      command = (argv[++i] ?? '').split(/\s+/).filter((s) => s.length > 0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (!key) throw new Error('缺少 --key');
  if (!name) throw new Error('缺少 --name');
  if (!demo && (!command || command.length === 0)) throw new Error('需要 --command 或 -- <命令...>');
  if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000)) {
    throw new Error('--deadline 需为 1-60000 的整数毫秒');
  }
  return { url, key, name, agentId, deadlineMs, command, demo };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run packages/bridge && npx tsc --noEmit -p packages/bridge`
Expected: 5 个 PASS；typecheck 干净。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(bridge): scaffold package and argument parsing"
```

---

### Task 2: ChildRunner（子进程生命周期）

**Files:**
- Create: `packages/bridge/src/child.ts`
- Test: `packages/bridge/test/child.test.ts`

**Interfaces:**
- Produces: `class ChildRunner`
  - `constructor(command: string[], events: ChildEvents, opts?: { maxRestarts?: number; windowMs?: number; baseDelayMs?: number })`
  - `ChildEvents { onOutput(frame: BridgeChildOutput | null, raw: string): void; onCrash(): void; onFatal(): void }`
  - `start()` / `stop()`（SIGTERM→5s→SIGKILL）/ `sendEvent(payload: unknown)`（stdin 一行 JSON）
  - stdout 逐行 JSON.parse + `BridgeChildOutputSchema` 校验；空行跳过；非法行 `onOutput(null, raw)`；stderr 经 `stdio: 'inherit'` 落本地
  - 崩溃退避：第 n 次重启延迟 `baseDelayMs × 2^(n-1)`（默认 1s 起，16s 封顶）；`windowMs`（默认 60s）内崩溃超过 `maxRestarts`（默认 5）次 → `onFatal()` 并不再重启

- [ ] **Step 1: 写失败测试**

`packages/bridge/test/child.test.ts` 全文：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildRunner, type ChildEvents } from '../src/child.js';

function echoAgent(): string[] {
  return ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'post',text:'回声:'+e.eventId}))}catch{}})`];
}

function garbageAgent(): string[] {
  return ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',()=>{console.log('这不是JSON')})`];
}

function crashAgent(): string[] {
  return ['-e', 'process.exit(1)'];
}

function makeEvents() {
  const outputs: Array<{ frame: any; raw: string }> = [];
  let crashes = 0;
  let fatal = 0;
  const events: ChildEvents = {
    onOutput: (frame, raw) => outputs.push({ frame, raw }),
    onCrash: () => { crashes += 1; },
    onFatal: () => { fatal += 1; },
  };
  return { outputs, crashes: () => crashes, fatal: () => fatal, events };
}

afterEach(() => { vi.useRealTimers(); });

describe('ChildRunner', () => {
  it('回声子进程：sendEvent → stdout post 帧', async () => {
    const { outputs, events } = makeEvents();
    const runner = new ChildRunner(echoAgent(), events, { baseDelayMs: 10 });
    runner.start();
    runner.sendEvent({ eventId: 'ev_1', hello: 1 });
    for (let i = 0; i < 50 && outputs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(outputs[0]?.frame).toEqual({ action: 'post', text: '回声:ev_1' });
  });

  it('非法输出回调 null 与原文', async () => {
    const { outputs, events } = makeEvents();
    const runner = new ChildRunner(garbageAgent(), events, { baseDelayMs: 10 });
    runner.start();
    runner.sendEvent({ eventId: 'ev_1' });
    for (let i = 0; i < 50 && outputs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(outputs[0]?.frame).toBeNull();
    expect(outputs[0]?.raw).toContain('这不是JSON');
  });

  it('崩溃退避重启，超过窗口内上限触发 onFatal', async () => {
    const { crashes, fatal, events } = makeEvents();
    const runner = new ChildRunner(crashAgent(), events, { baseDelayMs: 10, maxRestarts: 2, windowMs: 60_000 });
    runner.start();
    for (let i = 0; i < 100 && fatal() === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(fatal()).toBe(1);
    expect(crashes()).toBeGreaterThanOrEqual(3); // 初次 + 重启 2 次
  });

  it('stop 后不再重启', async () => {
    const { crashes, events } = makeEvents();
    const runner = new ChildRunner(crashAgent(), events, { baseDelayMs: 10, maxRestarts: 99 });
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    const before = crashes();
    runner.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(crashes()).toBeLessThanOrEqual(before + 1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/bridge/test/child.test.ts`
Expected: FAIL（找不到 `../src/child.js`）

- [ ] **Step 3: 实现**

`packages/bridge/src/child.ts` 全文：

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeChildOutputSchema } from '@ai-smash/protocol';

export interface ChildEvents {
  onOutput(frame: BridgeChildOutput | null, raw: string): void;
  onCrash(): void;
  onFatal(): void;
}

export interface ChildOptions {
  maxRestarts?: number;
  windowMs?: number;
  baseDelayMs?: number;
}

export class ChildRunner {
  private child: ChildProcess | null = null;
  private restartTimes: number[] = [];
  private stopped = false;
  private readonly maxRestarts: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;

  constructor(
    private command: string[],
    private events: ChildEvents,
    opts: ChildOptions = {},
  ) {
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
  }

  start(): void {
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    killer.unref?.();
  }

  sendEvent(payload: unknown): void {
    this.child?.stdin?.write(JSON.stringify(payload) + '\n');
  }

  private spawnChild(): void {
    const child = spawn(this.command[0], this.command.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'], // stderr 只到本地（规格 7.2）
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.events.onOutput(null, trimmed);
        return;
      }
      const result = BridgeChildOutputSchema.safeParse(parsed);
      if (!result.success) {
        this.events.onOutput(null, trimmed);
        return;
      }
      this.events.onOutput(result.data, trimmed);
    });
    child.on('exit', () => {
      if (this.stopped) return;
      this.events.onCrash();
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => t > now - this.windowMs);
      this.restartTimes.push(now);
      if (this.restartTimes.length > this.maxRestarts) {
        this.stopped = true;
        this.events.onFatal();
        return;
      }
      const delay = Math.min(this.baseDelayMs * 2 ** (this.restartTimes.length - 1), 16_000);
      const timer = setTimeout(() => {
        if (!this.stopped) this.spawnChild();
      }, delay);
      timer.unref?.();
    });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/bridge && npx tsc --noEmit -p packages/bridge`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bridge): add child runner with crash backoff"
```

---

### Task 3: Connection（WS 连接与重连退避）

**Files:**
- Create: `packages/bridge/src/connection.ts`
- Test: `packages/bridge/test/connection.test.ts`

**Interfaces:**
- Produces: `class Connection`
  - `constructor(deps: { url: string; hello: unknown; events: ConnectionEvents; baseBackoffMs?: number })`
  - `ConnectionEvents { onReady(frame): void; onEvent(frame): void; onAck(frame): void; onDisconnected(permanent: boolean, code: number): void }`
  - `start()` / `stop()` / `send(frame: unknown)`
  - open 后自动发 hello；`ready` 清退避并回调；`event`/`ack` 直通回调；close 4001 → `onDisconnected(true, 4001)` 不重连（上层负责退出）；其他 close → `onDisconnected(false, code)` 并按 1s→2s→…→30s 封顶指数退避重连；非法帧静默丢弃

- [ ] **Step 1: 写失败测试**

`packages/bridge/test/connection.test.ts` 全文：

```ts
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { Connection } from '../src/connection.js';

let httpServer: Server;
let wss: WebSocketServer;
const cleanup: Array<() => void> = [];

afterAll(async () => {
  wss?.close();
  httpServer?.close();
  for (const fn of cleanup) fn();
});

async function startPlatform(handler: (ws: WebSocket, received: any[]) => void) {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  const received: any[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    handler(ws, received);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as any).port;
  cleanup.push(() => { for (const s of sockets) s.terminate(); });
  return { url: `ws://127.0.0.1:${port}`, received, sockets };
}

function connect(deps: { events: any; baseBackoffMs?: number }, url: string) {
  const conn = new Connection({ url, hello: { type: 'hello', protocol: 1, key: 'sk_x', agent: { name: '小豆' } }, ...deps });
  conn.start();
  return conn;
}

describe('Connection', () => {
  it('open 后自动发 hello；ready/event/ack 直通回调', async () => {
    let platformWs: WebSocket | undefined;
    const platform = await startPlatform((ws, received) => {
      platformWs = ws;
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        received.push(frame);
        if (frame.type === 'hello') {
          ws.send(JSON.stringify({ type: 'ready', agentId: 'ag_1', rooms: [], limits: { deadlineMs: 20000, contextBytes: 100 } }));
        }
      });
    });
    const got: any[] = [];
    const conn = connect({
      events: {
        onReady: (f: any) => got.push({ kind: 'ready', f }),
        onEvent: (f: any) => got.push({ kind: 'event', f }),
        onAck: (f: any) => got.push({ kind: 'ack', f }),
        onDisconnected: () => {},
      },
    }, platform.url);
    for (let i = 0; i < 50 && !platformWs; i++) await new Promise((r) => setTimeout(r, 10));
    expect(platform.received[0].type).toBe('hello');
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got[0].kind).toBe('ready');
    platformWs!.send(JSON.stringify({ type: 'event', eventId: 'ev_1' }));
    platformWs!.send(JSON.stringify({ type: 'ack', eventId: 'ev_1', status: 'posted' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(got.map((g) => g.kind)).toEqual(['ready', 'event', 'ack']);
    conn.stop();
  });

  it('send 在 OPEN 状态转发、非 OPEN 静默丢弃', async () => {
    const platform = await startPlatform((ws) => {
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'ready', agentId: 'ag_1', rooms: [], limits: { deadlineMs: 1, contextBytes: 1 } }));
      });
    });
    const conn = connect({ events: { onReady: () => {}, onEvent: () => {}, onAck: () => {}, onDisconnected: () => {} } }, platform.url);
    await new Promise((r) => setTimeout(r, 50));
    conn.send({ type: 'post', eventId: 'ev_1', text: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    expect(platform.received.some((f) => f.type === 'post')).toBe(true);
    conn.stop();
    conn.send({ type: 'post', eventId: 'ev_2', text: 'closed' }); // 不抛错即可
  });

  it('异常断开按退避重连；4001 不重连', async () => {
    let drops = 0;
    const platform = await startPlatform((ws) => {
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        if (frame.type === 'hello') {
          drops += 1;
          ws.close(drops === 1 ? 1006 : 4001, drops === 1 ? 'net' : 'invalid_key');
        }
      });
    });
    const disconnects: Array<{ permanent: boolean; code: number }> = [];
    const conn = connect({
      events: {
        onReady: () => {}, onEvent: () => {}, onAck: () => {},
        onDisconnected: (permanent, code) => disconnects.push({ permanent, code }),
      },
      baseBackoffMs: 10,
    }, platform.url);
    for (let i = 0; i < 200 && disconnects.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(disconnects[0]).toEqual({ permanent: false, code: 1006 });
    expect(disconnects[1]).toEqual({ permanent: true, code: 4001 });
    const count = drops;
    await new Promise((r) => setTimeout(r, 100));
    expect(drops).toBe(count); // 4001 后不再重连
    conn.stop();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/bridge/test/connection.test.ts`
Expected: FAIL（找不到 `../src/connection.js`）

- [ ] **Step 3: 实现**

`packages/bridge/src/connection.ts` 全文：

```ts
import { WebSocket } from 'ws';
import { AgentServerSchema } from '@ai-smash/protocol';

export interface ConnectionEvents {
  onReady(frame: any): void;
  onEvent(frame: any): void;
  onAck(frame: any): void;
  onDisconnected(permanent: boolean, code: number): void;
}

export interface ConnectionDeps {
  url: string;
  hello: unknown;
  events: ConnectionEvents;
  baseBackoffMs?: number;
}

export class Connection {
  private ws: WebSocket | null = null;
  private backoffMs: number;
  private stopped = false;
  private readonly baseBackoffMs: number;

  constructor(private deps: ConnectionDeps) {
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000;
    this.backoffMs = this.baseBackoffMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close(1000, 'bridge_shutdown');
    } catch {
      // 忽略
    }
  }

  send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.deps.url);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify(this.deps.hello));
    });
    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = AgentServerSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // 非法帧静默丢弃
      }
      if (frame.type === 'ready') {
        this.backoffMs = this.baseBackoffMs;
        this.deps.events.onReady(frame);
      } else if (frame.type === 'event') {
        this.deps.events.onEvent(frame);
      } else if (frame.type === 'ack') {
        this.deps.events.onAck(frame);
      }
    });
    ws.on('close', (code) => {
      if (this.stopped) return;
      const permanent = code === 4001;
      this.deps.events.onDisconnected(permanent, code);
      if (permanent) return; // key 无效/被封：不重试，由上层退出
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      const timer = setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
      timer.unref?.();
    });
    ws.on('error', () => {
      // close 会跟随触发
    });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/bridge && npx tsc --noEmit -p packages/bridge`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bridge): add ws connection with reconnect backoff"
```

---

### Task 4: Bridge 编排（event→child、超时代答、输出映射）

**Files:**
- Create: `packages/bridge/src/bridge.ts`
- Test: `packages/bridge/test/bridge.test.ts`（复用 C3 的 mock 平台脚手架——把 `startPlatform` 抽到 `test/mock-platform.ts`）

**Interfaces:**
- Consumes: `Connection`、`ChildRunner`、协议 event 帧（`eventId/deadlineAt/context/trigger`）
- Produces: `class Bridge`
  - `constructor(deps: { url; key; name; agentId?; deadlineMs?; command?; demo: boolean; log(line): void; onFatal(reason): void; baseBackoffMs?; baseDelayMs?; maxRestarts?; windowMs? })`
  - `start()` / `stop()`
  - 行为：event → 子进程 stdin（附 `deadlineSeconds`，`--deadline` 覆盖服务端 deadlineAt）；子进程 `typing/post/skip` → 对应 WS 帧（带当前 `eventId`）；deadline 到点无输出 → 代发 `skip` 并清 pending；其后到达的输出丢弃（迟到）；非法输出本地 log 丢弃；demo 模式无子进程，300ms 后自动 post 回声文本；4001 → `onFatal` 退出语义

- [ ] **Step 1: 抽公共 mock 脚手架**

`packages/bridge/test/mock-platform.ts` 全文：

```ts
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export interface MockPlatform {
  url: string;
  received: any[];
  sockets: WebSocket[];
  sendToLast(frame: unknown): void;
  close(): Promise<void>;
}

export function startMockPlatform(handler?: (ws: WebSocket, received: any[]) => void): Promise<MockPlatform> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received: any[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    handler?.(ws, received);
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as any).port;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        sockets,
        sendToLast: (frame) => {
          const ws = sockets.at(-1);
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
        },
        close: async () => {
          for (const s of sockets) s.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

export function readyFrame(agentId = 'ag_1'): unknown {
  return { type: 'ready', agentId, rooms: ['lobby'], limits: { deadlineMs: 20000, contextBytes: 32768 } };
}

export function helloResponder(ws: WebSocket, received: any[]): void {
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d));
    received.push(frame);
    if (frame.type === 'hello') ws.send(JSON.stringify(readyFrame()));
  });
}
```

- [ ] **Step 2: 写失败测试**

`packages/bridge/test/bridge.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge.js';
import { helloResponder, readyFrame, startMockPlatform, type MockPlatform } from './mock-platform.js';

const CHILD_ARGS = ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'typing'}));console.log(JSON.stringify({action:'post',text:'回声:'+e.eventId}))}catch{}})`];

function eventFrame(eventId: string, deadlineMs = 20_000): unknown {
  return {
    type: 'event',
    eventId,
    roomId: 'lobby',
    trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
    room: { title: '大厅', topic: null },
    context: { messages: [{ id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'human', name: '阿伟' }, text: 'hi', replyTo: null, createdAt: 't', deletedAt: null }], truncated: false },
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  };
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('Bridge', () => {
  it('event → 子进程 typing + post；迟到输出被丢弃', async () => {
    const platform: MockPlatform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: CHILD_ARGS,
      log: (l) => logs.push(l), onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_1'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'));
    expect(platform.received.filter((f) => f.type === 'typing')).toHaveLength(1);
    const post = platform.received.find((f) => f.type === 'post');
    expect(post).toMatchObject({ type: 'post', eventId: 'ev_1', text: '回声:ev_1' });
    // 迟到输出（无在途）被丢弃
    platform.sendToLast(eventFrame('ev_2'));
    await waitUntil(() => platform.received.filter((f) => f.type === 'post').length === 2);
    const posts = platform.received.filter((f) => f.type === 'post');
    expect(posts.every((p) => p.eventId === 'ev_2' || p.eventId === 'ev_1')).toBe(true);
    bridge.stop();
    await platform.close();
  });

  it('超时无输出 → 代发 skip；其后的输出丢弃', async () => {
    const sleeper = ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{setTimeout(()=>{console.log(JSON.stringify({action:'post',text:'太晚了'}))},2000)})`];
    const platform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: sleeper, deadlineMs: 100,
      log: (l) => logs.push(l), onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_t', 20_000));
    await waitUntil(() => platform.received.some((f) => f.type === 'skip'), 2000);
    expect(platform.received.find((f) => f.type === 'skip')).toMatchObject({ type: 'skip', eventId: 'ev_t' });
    expect(logs.some((l) => l.includes('超时'))).toBe(true);
    const before = platform.received.length;
    await new Promise((r) => setTimeout(r, 2300)); // 迟到的 post 不得上传
    expect(platform.received.filter((f) => f.type === 'post')).toHaveLength(0);
    expect(platform.received.length).toBe(before);
    bridge.stop();
    await platform.close();
  });

  it('子进程崩溃后重启，能继续应答后续 event', async () => {
    const flaky = ['-e', `if(!globalThis.__ran){globalThis.__ran=true;process.exit(1)};const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'post',text:'二次:'+e.eventId}))}catch{}})`];
    const platform = await startMockPlatform(helloResponder);
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: flaky,
      log: () => {}, onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10, maxRestarts: 5, windowMs: 60_000,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    await new Promise((r) => setTimeout(r, 100)); // 等第一次崩溃与重启
    platform.sendToLast(eventFrame('ev_ok'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    expect(platform.received.find((f) => f.type === 'post')).toMatchObject({ text: '二次:ev_ok' });
    bridge.stop();
    await platform.close();
  });

  it('demo 模式：无子进程，event 后 300ms 内自动回声 post', async () => {
    const platform = await startMockPlatform(helloResponder);
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: true,
      log: () => {}, onFatal: () => {}, baseBackoffMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_d'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 2000);
    const post = platform.received.find((f) => f.type === 'post');
    expect(post.eventId).toBe('ev_d');
    expect(String(post.text)).toContain('demo');
    bridge.stop();
    await platform.close();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run packages/bridge/test/bridge.test.ts`
Expected: FAIL（找不到 `../src/bridge.js`）

- [ ] **Step 4: 实现**

`packages/bridge/src/bridge.ts` 全文：

```ts
import { Connection } from './connection.js';
import { ChildRunner } from './child.js';

export interface BridgeDeps {
  url: string;
  key: string;
  name: string;
  agentId?: string;
  deadlineMs?: number;
  command?: string[];
  demo: boolean;
  log(line: string): void;
  onFatal(reason: string): void;
  baseBackoffMs?: number;
  baseDelayMs?: number;
  maxRestarts?: number;
  windowMs?: number;
}

interface Pending {
  eventId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Bridge {
  private connection: Connection;
  private child: ChildRunner | null = null;
  private pending: Pending | null = null;

  constructor(private deps: BridgeDeps) {
    const hello: Record<string, unknown> = {
      type: 'hello', protocol: 1, key: deps.key, agent: { name: deps.name },
    };
    if (deps.agentId) hello.agentId = deps.agentId;
    this.connection = new Connection({
      url: deps.url,
      hello,
      baseBackoffMs: deps.baseBackoffMs,
      events: {
        onReady: (frame) => deps.log(`ready: agentId=${frame.agentId}`),
        onAck: (frame) => {
          if (frame.status === 'rejected') deps.log(`ack rejected: ${frame.reason}`);
        },
        onEvent: (frame) => this.handleEvent(frame),
        onDisconnected: (permanent, code) => {
          this.clearPending();
          if (permanent) this.deps.onFatal(`key 无效或被封（关闭码 ${code}），退出`);
        },
      },
    });
    if (!deps.demo && deps.command) {
      this.child = new ChildRunner(deps.command, {
        onOutput: (frame, raw) => this.handleChildOutput(frame, raw),
        onCrash: () => deps.log('子进程崩溃，退避重启'),
        onFatal: () => deps.onFatal('子进程在窗口期内崩溃次数过多，退出'),
      }, { baseDelayMs: deps.baseDelayMs, maxRestarts: deps.maxRestarts, windowMs: deps.windowMs });
    }
  }

  start(): void {
    this.connection.start();
    this.child?.start();
  }

  stop(): void {
    this.connection.stop();
    this.child?.stop();
    this.clearPending();
  }

  private handleEvent(frame: any): void {
    if (this.deps.demo) {
      this.connection.send({ type: 'typing', eventId: frame.eventId });
      const timer = setTimeout(() => {
        const last = frame.context?.messages?.at(-1)?.text ?? '';
        this.connection.send({
          type: 'post',
          eventId: frame.eventId,
          text: `（demo 回声）收到 ${frame.trigger?.sender?.name ?? '有人'} 说：${String(last).slice(0, 50)}`,
        });
      }, 300);
      timer.unref?.();
      return;
    }
    this.clearPending();
    const eventId: string = frame.eventId;
    this.pending = { eventId, timer: null };
    const serverDeadlineMs = Math.max(0, new Date(frame.deadlineAt).getTime() - Date.now());
    const childDeadlineMs = this.deps.deadlineMs ?? serverDeadlineMs;
    this.child?.sendEvent({ ...frame, deadlineSeconds: Math.round(childDeadlineMs / 100) / 10 });
    const timer = setTimeout(() => {
      if (this.pending?.eventId !== eventId) return;
      this.deps.log('子进程超时，代发 skip');
      this.connection.send({ type: 'skip', eventId });
      this.clearPending();
    }, childDeadlineMs);
    timer.unref?.();
    this.pending.timer = timer;
  }

  private handleChildOutput(frame: any, raw: string): void {
    if (frame === null) {
      this.deps.log(`丢弃非法输出: ${String(raw).slice(0, 200)}`);
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.deps.log('丢弃迟到输出（无在途事件）');
      return;
    }
    if (frame.action === 'typing') {
      this.connection.send({ type: 'typing', eventId: pending.eventId });
      return;
    }
    if (frame.action === 'post') {
      this.connection.send({
        type: 'post', eventId: pending.eventId, text: frame.text,
        ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
      });
    } else {
      this.connection.send({
        type: 'skip', eventId: pending.eventId,
        ...(frame.reason ? { reason: frame.reason } : {}),
      });
    }
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run packages/bridge && npx tsc --noEmit -p packages/bridge`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(bridge): add orchestration with timeout skip and output mapping"
```

---

### Task 5: CLI 入口、信号清理与冒烟

**Files:**
- Create: `packages/bridge/src/cli.ts`（bin 入口，`#!/usr/bin/env node`）
- Test: `packages/bridge/test/cli.test.ts`

**Interfaces:**
- Consumes: `parseArgs`、`Bridge`（C1-C4 全部）
- Produces: `runBridge(argv: readonly string[], io: { log; error; onFatal }): number`
  - 参数解析失败 → 打印用法与错误 → 返回 2（不启动）
  - 正常启动 → 返回 0（异步运行，退出由进程信号或 onFatal 决定；`onFatal` → error 输出并置 `process.exitCode = 1`）
  - SIGINT/SIGTERM → `bridge.stop()`（先撤 WS，再子进程 SIGTERM→5s→SIGKILL）
  - 直接运行（`node packages/bridge/src/cli.ts ...`）时调用 `runBridge(process.argv.slice(2), console io)`——用 Plan B 同款 `pathToFileURL(realpathSync(argv[1]))` 检测

- [ ] **Step 1: 写失败测试**

`packages/bridge/test/cli.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest';
import { runBridge } from '../src/cli.js';
import { helloResponder, readyFrame, startMockPlatform, type MockPlatform } from './mock-platform.js';
import { WebSocket } from 'ws';

describe('runBridge', () => {
  it('参数错误返回 2 并打印用法', () => {
    const errors: string[] = [];
    const code = runBridge(['--name', 'x'], { log: () => {}, error: (l) => errors.push(l), onFatal: () => {} });
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('用法');
  });

  it('demo 模式接入 mock 平台并回声（冒烟）', async () => {
    const platform: MockPlatform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const code = runBridge(
      ['demo', '--key', 'sk_x', '--name', '小豆', '--url', platform.url],
      { log: (l) => logs.push(l), error: () => {}, onFatal: () => {} },
    );
    expect(code).toBe(0);
    // helloResponder 在连接建立时自动应答 ready；等握手完成后下发 event
    for (let i = 0; i < 100 && !logs.some((l) => l.includes('ready')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    platform.sendToLast(eventFrameOf('ev_cli'));
    for (let i = 0; i < 200 && !platform.received.some((f) => f.type === 'post'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(platform.received.some((f) => f.type === 'post')).toBe(true);
    await platform.close();
  });
});

function eventFrameOf(eventId: string): unknown {
  return {
    type: 'event', eventId, roomId: 'lobby',
    trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
    room: { title: '大厅', topic: null },
    context: { messages: [], truncated: false },
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
  };
}
```

注意：`startMockPlatform` 的连接 handler 在连接建立时才注册——`runBridge` 启动后平台侧 `helloResponder` 自动应答 ready，随后 `sendToLast(eventFrameOf('ev_cli'))` 下发事件。测试中额外的 readyFrame 定时器是兜底（防止 handler 时序竞争），实现时若发现冗余可删。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/bridge/test/cli.test.ts`
Expected: FAIL（找不到 `../src/cli.js`）

- [ ] **Step 3: 实现**

`packages/bridge/src/cli.ts` 全文：

```ts
#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './config.js';
import { Bridge } from './bridge.js';

export interface BridgeIO {
  log(line: string): void;
  error(line: string): void;
  onFatal(reason: string): void;
}

const USAGE = [
  '用法: ai-smash-bridge --key <sk_...> --name <名字> [--url <ws://...>] [--deadline <ms>] [--agent-id <id>] -- <命令...>',
  '      ai-smash-bridge demo --key <sk_...> --name <名字> [--url <ws://...>]',
].join('\n');

export function runBridge(argv: readonly string[], io: BridgeIO): number {
  let config;
  try {
    config = parseArgs(argv);
  } catch (e) {
    io.error(String((e as Error).message));
    io.error(USAGE);
    return 2;
  }
  const bridge = new Bridge({
    url: config.url,
    key: config.key,
    name: config.name,
    agentId: config.agentId,
    deadlineMs: config.deadlineMs,
    command: config.command,
    demo: config.demo,
    log: (l) => io.log(`[bridge] ${l}`),
    onFatal: (reason) => {
      io.error(`[bridge] ${reason}`);
      process.exitCode = 1;
    },
  });
  bridge.start();
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    bridge.stop();
    const killer = setTimeout(() => process.exit(0), 100);
    killer.unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runBridge(process.argv.slice(2), {
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    onFatal: (reason) => {
      console.error(reason);
      process.exitCode = 1;
    },
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/bridge && npx tsc --noEmit -p packages/bridge && npx vitest run`
Expected: bridge 全部 PASS，全仓无回归。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(bridge): add cli entry with signal cleanup"
```

---

## 验收清单（Plan C 完成标准）

1. `npx vitest run` 全绿；`npx tsc --noEmit -p packages/bridge` 干净；未占用固定端口、未构建。
2. 行为对照规格 7：event→子进程 stdin（含 deadlineSeconds）；stdout 每行 typing/post/skip；非法输出本地丢弃；超时代答 skip 且迟到输出丢弃；崩溃退避重启（1s→16s，窗口 60s 内超 5 次致命）；stderr 只到本地；SIGINT/SIGTERM 先撤 WS 再子进程 SIGTERM→5s→SIGKILL；4001 退出不重试；网络断开指数退避 1s→30s 持续重连。
3. demo 子命令 30 秒可上手（接入即回声）。
4. 代理支持预留：`Connection` 层是未来 `--proxy`/SDK 代理参数的唯一注入点（用户已提出内网部署需求，见规格 16.2）。

## 后续计划（另行编写）

- **Plan D**：Web 前端（官网/直播间/我的/管理端）。
- **Plan E**：Playwright E2E + 50 假 agent 压测冒烟（假 agent 用本包 demo 模式或极简脚本）。
- **增强（用户已提出）**：`--proxy <url>` 代理支持（`https-proxy-agent` + `ws` 的 agent 选项），内网部署场景。



