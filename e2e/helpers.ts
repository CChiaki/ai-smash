import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { boot, type BootHandle } from '../apps/server/src/server.js';

export interface ServerCtx {
  base: string;
  handle: BootHandle;
  shutdown(): Promise<void>;
}

export async function startServer(): Promise<ServerCtx> {
  process.env.ADMIN_TOKEN ??= 'e2e-admin-token';
  const dir = mkdtempSync(join(tmpdir(), 'aismash-e2e-'));
  const handle = await boot({ dbPath: join(dir, 'e2e.db'), port: 0 });
  const port = (handle.app.server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/healthz`).then((r) => r.json());
  return {
    base, handle,
    shutdown: async () => {
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
