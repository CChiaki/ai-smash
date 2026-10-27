import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { boot, type BootHandle } from '../apps/server/src/server.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface ServerCtx {
  base: string;
  webBase: string;
  handle: BootHandle;
  shutdown(): Promise<void>;
}

// 起独立 vite dev server（web 前后端分离部署形态）：API/WS 跨源，服务端以 CORS_ORIGIN 放行
// 注：cwd 用 apps/web —— vite 的 root 取 process.cwd()，从仓库根起会 404（站根解析不到 apps/web/index.html）
async function startVite(apiBase: string): Promise<{ child: ReturnType<typeof spawn>; webBase: string }> {
  const webDir = join(REPO_ROOT, 'apps', 'web');
  const viteBin = join(REPO_ROOT, 'node_modules', '.bin', 'vite');
  const child = spawn(viteBin, ['--config', join(webDir, 'vite.config.ts'), '--port', '0', '--strictPort', 'false'], {
    cwd: webDir,
    env: { ...process.env, VITE_API_BASE: apiBase, ADMIN_TOKEN: 'e2e-admin-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => { out += String(d); });
  child.stderr!.on('data', (d: Buffer) => { out += String(d); });

  // vite 输出带 ANSI 色码（Local: http://localhost:\x1b[1m5174…），先剥离再解析端口
  const plain = (): string => out.replace(/\x1b\[[0-9;]*m/g, '');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const m = plain().match(/http:\/\/localhost:(\d+)\//);
    if (m) {
      const webBase = `http://localhost:${m[1]}`;
      try {
        const res = await fetch(webBase);
        if (res.ok) return { child, webBase };
      } catch { /* vite 未就绪，继续轮询 */ }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`vite dev server 未在 30s 内就绪，输出：\n${out}`);
}

export async function startServer(): Promise<ServerCtx> {
  process.env.ADMIN_TOKEN ??= 'e2e-admin-token';
  const dir = mkdtempSync(join(tmpdir(), 'aismash-e2e-'));
  const handle = await boot({ dbPath: join(dir, 'e2e.db'), port: 0, corsOrigin: '*' });
  const port = (handle.app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/healthz`).then((r) => r.json());
  const { child, webBase } = await startVite(base);
  return {
    base, webBase, handle,
    shutdown: async () => {
      child.kill();
      await handle.shutdown();
    },
  };
}

export async function newKey(base: string, label?: string): Promise<string> {
  const res = await fetch(`${base}/api/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(label ? { label } : {}),
  });
  return (await res.json()).key as string;
}

export async function createRoom(base: string, key: string, over: Record<string, unknown> = {}): Promise<{ id: string; inviteCode: string | null }> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ title: 'E2E 房间', visibility: 'public', ...over }),
  });
  return await res.json();
}

export async function postHuman(base: string, key: string, roomId: string, text: string): Promise<void> {
  const res = await fetch(`${base}/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ text }),
  });
  if (res.status !== 201) throw new Error(`postHuman failed: ${res.status}`);
}

export interface AgentClient {
  frames: any[];
  waitFrame(type: string, timeoutMs?: number): Promise<any>;
  send(obj: unknown): void;
  close(): void;
}

export async function connectAgent(base: string, key: string, name: string): Promise<AgentClient> {
  const url = base.replace('http:', 'ws:') + '/ws/agent';
  const ws = new WebSocket(url);
  const frames: any[] = [];
  const waiters: Array<{ type: string; resolve: (f: any) => void }> = [];
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d));
    frames.push(frame);
    const i = waiters.findIndex((w) => w.type === frame.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
  });
  await new Promise<void>((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, key, agent: { name } }));
  const client: AgentClient = {
    frames,
    waitFrame: (type, timeoutMs = 10_000) => new Promise((resolve, reject) => {
      const found = frames.find((f) => f.type === type);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`frame ${type} timeout; got ${frames.map((f) => f.type).join(',')}`)), timeoutMs);
      waiters.push({ type, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  };
  await client.waitFrame('joined');
  return client;
}
