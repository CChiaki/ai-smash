import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newInviteCode, newKey, sha256 } from '../src/ids.js';
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

function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  let resolveClosed: (v: { code: number }) => void;
  const closed = new Promise<{ code: number }>((r) => { resolveClosed = r; });
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  ws.on('close', (code) => resolveClosed({ code }));
  const ready = new Promise<void>((r) => ws.on('open', r));
  return ready.then(() => ({ ws, frames, closed }));
}

function send(ws: WebSocket, frame: unknown): void { ws.send(JSON.stringify(frame)); }

const seen = new WeakSet<object>();
async function next(frames: any[], type: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const f = [...frames].reverse().find((x) => x.type === type && !seen.has(x));
    if (f) { seen.add(f); return f; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`frame ${type} not received; got ${JSON.stringify(frames)}`);
}

async function connectAgent(handle: ReturnType<typeof composeServer>, url: string, name: string) {
  const raw = newKey();
  handle.storage.createKey({ id: `key_${name}`, hash: sha256(raw), label: null, createdAt: 't' });
  const c = await connect(url);
  send(c.ws, { type: 'hello', protocol: 1, key: raw, agent: { name } });
  await next(c.frames, 'joined');
  return c;
}

describe('human gateway', () => {
  it('匿名看公开房：ready 带消息与 presence，you 为 null；发言被拒 unauthorized', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const agentC = await connectAgent(handle, agentUrl, '小豆');
    handle.engine.humanPost('lobby', 'key_x', '阿伟', '历史消息');
    const c = await connect(humanUrl);
    send(c.ws, { type: 'hello', roomId: 'lobby' });
    const ready = await next(c.frames, 'ready');
    expect(ready.room.id).toBe('lobby');
    expect(ready.messages.at(-1).text).toBe('历史消息');
    expect(ready.you).toBeNull();
    expect(ready.agents.some((a: any) => a.name === '小豆')).toBe(true);
    send(c.ws, { type: 'post', text: '匿名发言' });
    expect((await next(c.frames, 'error')).code).toBe('unauthorized');
    c.ws.terminate();
    agentC.ws.terminate();
  });

  it('持 key 发言 → 双方收到 message 广播', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_h1', hash: sha256(raw), label: '阿伟', createdAt: 't' });
    const agentC = await connectAgent(handle, agentUrl, '老豆');
    const human = await connect(humanUrl);
    send(human.ws, { type: 'hello', roomId: 'lobby', key: raw });
    await next(human.frames, 'ready');
    send(human.ws, { type: 'post', text: '人来了' });
    const msg = await next(human.frames, 'message');
    expect(msg.message.text).toBe('人来了');
    expect(msg.message.sender.name).toBe('阿伟');
    human.ws.terminate();
    agentC.ws.terminate();
  });

  it('私有房：匿名 close 4003，成员可看', async () => {
    const { handle, humanUrl } = await start();
    const ownerRaw = newKey();
    handle.storage.createKey({ id: 'key_own', hash: sha256(ownerRaw), label: null, createdAt: 't' });
    const room = handle.storage.createRoom({
      id: 'rm_priv', title: '私密', topic: null, visibility: 'private',
      ownerKeyId: 'key_own', inviteCode: newInviteCode(), cooldownMs: 10_000, maxAgents: 20, at: 't',
    });
    const anon = await connect(humanUrl);
    send(anon.ws, { type: 'hello', roomId: 'rm_priv' });
    expect((await anon.closed).code).toBe(4003);
    const memberRaw = newKey();
    handle.storage.createKey({ id: 'key_mem', hash: sha256(memberRaw), label: null, createdAt: 't' });
    handle.storage.addMember('rm_priv', 'key_mem', 'member', 't');
    const member = await connect(humanUrl);
    send(member.ws, { type: 'hello', roomId: 'rm_priv', key: memberRaw });
    const ready = await next(member.frames, 'ready');
    expect(ready.room.id).toBe('rm_priv');
    expect(ready.you.isOwner).toBe(false);
    anon.ws.terminate();
    member.ws.terminate();
  });

  it('maxPayload 超限帧导致连接关闭（1009）', async () => {
    const { humanUrl } = await start();
    const c = await connect(humanUrl);
    const closedCode = await new Promise<number>((resolve) => {
      c.ws.on('close', (code) => resolve(code));
      c.ws.send('x'.repeat(1.2 * 1024 * 1024));
    });
    expect(closedCode).toBe(1009);
  });

  it('非法 post 帧（空/超长文本）回 error 帧而非静默丢弃，连接保持可用', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_h2', hash: sha256(raw), label: '阿伟', createdAt: 't' });
    const agentC = await connectAgent(handle, agentUrl, '答手');
    const human = await connect(humanUrl);
    send(human.ws, { type: 'hello', roomId: 'lobby', key: raw });
    await next(human.frames, 'ready');
    // 空文本 / 超长文本：服务端必须给 error 帧（此前静默丢弃，人类端消息凭空消失）
    send(human.ws, { type: 'post', text: '' });
    expect((await next(human.frames, 'error')).code).toBe('invalid');
    send(human.ws, { type: 'post', text: 'x'.repeat(4001) });
    expect((await next(human.frames, 'error')).code).toBe('invalid');
    expect(human.ws.readyState).toBe(WebSocket.OPEN); // 拒收不拆连接
    // 连接仍健康：随后正常发言成功
    send(human.ws, { type: 'post', text: '正常发言' });
    const msg = await next(human.frames, 'message');
    expect(msg.message.text).toBe('正常发言');
    human.ws.terminate();
    agentC.ws.terminate();
  });

  it('kick → presence 广播刷新', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const agentC = await connectAgent(handle, agentUrl, '五豆');
    const viewer = await connect(humanUrl);
    send(viewer.ws, { type: 'hello', roomId: 'lobby' });
    await next(viewer.frames, 'ready');
    const agentId = handle.storage.listAgents().find((a) => a.name === '五豆')!.id;
    handle.engine.kickAgent('lobby', agentId);
    const presence = await next(viewer.frames, 'presence');
    expect(presence.agents.some((a: any) => a.agentId === agentId)).toBe(false);
    agentC.ws.terminate();
    viewer.ws.terminate();
  });

  it('agent 断开（socket 关闭）→ 观众 presence 刷新、agent 从面板消失且置 offline', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const agentC = await connectAgent(handle, agentUrl, '断线豆');
    const viewer = await connect(humanUrl);
    send(viewer.ws, { type: 'hello', roomId: 'lobby' });
    await next(viewer.frames, 'ready');
    const agentId = handle.storage.listAgents().find((a) => a.name === '断线豆')!.id;
    agentC.ws.terminate(); // 模拟 agent 进程死亡/断网（无优雅关闭帧）
    const presence = await next(viewer.frames, 'presence');
    expect(presence.agents.some((a: any) => a.agentId === agentId)).toBe(false);
    expect(handle.storage.getAgent(agentId)?.status).toBe('offline');
    viewer.ws.terminate();
  });
});
