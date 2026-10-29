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
  for (let i = 0; i < 100; i++) {
    const f = frames.find((x) => x.type === type);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}

describe('单 key Agent 上限与网关崩溃回归', () => {
  it('被踢出大厅的 Agent 重连：连接被关而非服务端崩溃', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_k', hash: sha256(raw), label: null, createdAt: 't' });
    const agent = handle.storage.upsertAgent({ keyId: 'key_k', name: '被踢豆', at: 't' });
    handle.storage.setAgentStatus(agent.id, 'online', 't');
    handle.storage.addRoomAgent('lobby', agent.id, 'active', 't');
    handle.storage.setRoomAgentStatus('lobby', agent.id, 'kicked'); // 被踢

    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '被踢豆' } });
    const closed = await c.closed;
    expect(closed.reason).toContain('kicked'); // 引擎的 kicked 语义透传
    expect(closed.code).toBe(4003);
    c.ws.terminate();

    // 服务端存活：新连接照常工作
    const c2 = await connect(url);
    send(c2.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '重生豆' } });
    const ready = await next(c2.frames, 'ready');
    expect(ready.agentId).toBeTruthy();
    c2.ws.terminate();
  });

  it('被踢 Agent 两次重连均被拒，kicked 行不因 close 清理丢失', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_m', hash: sha256(raw), label: null, createdAt: 't' });
    const agent = handle.storage.upsertAgent({ keyId: 'key_m', name: '双拒豆', at: 't' });
    handle.storage.setAgentStatus(agent.id, 'online', 't');
    handle.storage.addRoomAgent('lobby', agent.id, 'active', 't');
    handle.storage.setRoomAgentStatus('lobby', agent.id, 'kicked'); // 被踢

    // 第 1 次重连：close reason 含 kicked
    const c1 = await connect(url);
    send(c1.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '双拒豆' } });
    const closed1 = await c1.closed;
    expect(closed1.reason).toContain('kicked');
    expect(closed1.code).toBe(4003);

    // 第 2 次重连（新连接）：仍被拒，kicked 行未因 close 清理被删除
    const c2 = await connect(url);
    send(c2.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '双拒豆' } });
    const closed2 = await c2.closed;
    expect(closed2.reason).toContain('kicked');
    expect(closed2.code).toBe(4003);

    expect(handle.storage.getRoomAgent('lobby', agent.id)?.status).toBe('kicked');
    c1.ws.terminate();
    c2.ws.terminate();
  });

  it('hello 时 joinRoom 抛 forbidden：连接被关（引擎错误语义透传），服务端存活', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_l', hash: sha256(raw), label: null, createdAt: 't' });
    // stub 引擎 joinRoom：模拟引擎层 forbidden（如单 key Agent 上限）
    const orig = handle.engine.joinRoom.bind(handle.engine);
    (handle.engine as any).joinRoom = (agentId: string, roomId: string) => {
      if (roomId === 'lobby') throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      return orig(agentId, roomId);
    };
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '限额豆' } });
    const closed = await c.closed;
    expect(closed.reason).toContain('forbidden');
    expect(closed.code).toBe(4003);
    c.ws.terminate();

    // 服务端存活：恢复引擎后新连接正常
    (handle.engine as any).joinRoom = orig;
    const c2 = await connect(url);
    send(c2.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '恢复豆' } });
    const ready = await next(c2.frames, 'ready');
    expect(ready.agentId).toBeTruthy();
    c2.ws.terminate();
  });
});
