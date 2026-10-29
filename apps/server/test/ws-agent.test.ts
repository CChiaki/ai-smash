import { WebSocket } from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { AGENT_MAX_PAYLOAD } from '../src/ws/agent-gateway.js';
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
  for (let i = 0; i < 50; i++) {
    const f = frames.find((x) => x.type === type && !seen.has(x));
    if (f) { seen.add(f); return f; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}
const seen = new WeakSet<object>();

describe('agent gateway', () => {
  it('无效 key 关闭 4001', async () => {
    const { url } = await start();
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: 'sk_bad', agent: { name: '小豆' } });
    expect((await c.closed).code).toBe(4001);
    c.ws.terminate();
  });

  it('hello → ready + joined(lobby)；ping → pong', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_a', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } });
    const ready = await next(c.frames, 'ready');
    expect(ready.agentId).toBeTruthy();
    expect(ready.limits.deadlineMs).toBe(20_000);
    expect(ready.limits.contextBytes).toBe(32_768);
    const joined = await next(c.frames, 'joined');
    expect(joined.roomId).toBe('lobby');
    expect(['active', 'waiting']).toContain(joined.status);
    send(c.ws, { type: 'ping', t: 1 });
    expect((await next(c.frames, 'pong')).t).toBe(1);
    expect(handle.storage.getAgent(ready.agentId)?.status).toBe('online');
    c.ws.terminate();
  });

  it('假 eventId post → ack rejected stale；join 未知房间 → error 帧', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_b', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '老豆' } });
    const ready = await next(c.frames, 'ready');
    send(c.ws, { type: 'post', eventId: 'ev_fake', text: '冒充' });
    const ack = await next(c.frames, 'ack');
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('stale');
    send(c.ws, { type: 'join', roomId: 'rm_no' });
    const err = await next(c.frames, 'error');
    expect(err.code).toBe('not_found');
    c.ws.terminate();
  });

  it('human 投喂 → agent 收到 event；post → ack posted + 落库', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_c', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '三豆' } });
    await next(c.frames, 'joined');
    handle.engine.humanPost('lobby', 'key_x', '阿伟', '起个头');
    const event = await next(c.frames, 'event');
    expect(event.context.messages.at(-1).text).toBe('起个头');
    send(c.ws, { type: 'post', eventId: event.eventId, text: '我接一句' });
    const ack = await next(c.frames, 'ack');
    expect(ack.status).toBe('posted');
    expect(handle.storage.listMessages('lobby').at(-1)?.senderKind).toBe('agent');
    c.ws.terminate();
  });

  it('房间暂停/恢复 → agent 收到 state 帧 roomStatus（规格 6.4/18）', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_pause', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '暂停豆' } });
    const ready = await next(c.frames, 'ready');
    await next(c.frames, 'joined'); // 已进大厅
    handle.engine.pauseRoom('lobby');
    const paused = await next(c.frames, 'state');
    expect(paused.roomStatus).toBe('paused');
    expect(paused.roomId).toBe('lobby');
    expect(paused.agentId).toBe(ready.agentId);
    handle.engine.resumeRoom('lobby');
    const resumed = await next(c.frames, 'state');
    expect(resumed.roomStatus).toBe('active');
    c.ws.terminate();
  });

  it('forceDisconnect 关闭 4003 且标记 offline', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_d', hash: sha256(raw), label: null, createdAt: 't' });
    const c = await connect(url);
    send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '四豆' } });
    const ready = await next(c.frames, 'ready');
    handle.agentGateway.forceDisconnect(ready.agentId);
    expect((await c.closed).code).toBe(4003);
    await new Promise((r) => setTimeout(r, 20));
    expect(handle.storage.getAgent(ready.agentId)?.status).toBe('offline');
  });

  it('maxPayload 超限帧导致连接关闭（1009）', async () => {
    const { url } = await start();
    const c = await connect(url);
    const closedCode = await new Promise<number>((resolve) => {
      c.ws.on('close', (code) => resolve(code));
      c.ws.send('x'.repeat(AGENT_MAX_PAYLOAD + 1));
    });
    expect(closedCode).toBe(1009);
  });

  it('协议上限的 4×700KB base64 附件 post 帧不会被 maxPayload 断连', async () => {
    const { url } = await start();
    const c = await connect(url);
    const closedCode = await new Promise<number | null>((resolve) => {
      c.ws.on('close', (code) => resolve(code));
      // 恰好在网关容量内：4 个 700KB base64 附件 + 正文 + JSON 包裹
      const big = { type: 'hello', protocol: 1, key: 'k', agent: { name: '大附件豆' } };
      c.ws.send(JSON.stringify(big));
      setTimeout(() => {
        c.ws.send(JSON.stringify({
          type: 'post', eventId: 'e1', text: '看图',
          attachments: Array.from({ length: 4 }, () => ({ kind: 'image', base64: 'A'.repeat(700_000) })),
        }));
        setTimeout(() => resolve(null), 300); // 存活即视为未被 1009 断连
      }, 100);
    });
    expect(closedCode).not.toBe(1009);
    c.ws.terminate();
  });

  it('顶号：旧连接 4000 关闭，新连接保持在线与房间成员', async () => {
    const { handle, url } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_dup', hash: sha256(raw), label: null, createdAt: 't' });
    const c1 = await connect(url);
    send(c1.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '顶号豆' } });
    const ready1 = await next(c1.frames, 'ready');
    const c2 = await connect(url);
    send(c2.ws, { type: 'hello', protocol: 1, key: raw, agent: { name: '顶号豆' } });
    const ready2 = await next(c2.frames, 'ready');
    expect(ready2.agentId).toBe(ready1.agentId); // 同名同 key 复用身份
    expect((await c1.closed).code).toBe(4000);
    await new Promise((r) => setTimeout(r, 50)); // 等旧连接 close 清理跑完
    expect(handle.agentGateway.onlineCount()).toBe(1);
    expect(handle.storage.getAgent(ready2.agentId)?.status).toBe('online');
    expect(handle.storage.getRoomAgent('lobby', ready2.agentId)?.status).toBe('active');
    c2.ws.terminate();
  });
});
