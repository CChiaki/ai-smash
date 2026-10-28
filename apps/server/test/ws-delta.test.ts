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
  servers.push({ close: () => handle.close() });
  return {
    handle,
    agentUrl: `ws://127.0.0.1:${port}/ws/agent`,
    humanUrl: `ws://127.0.0.1:${port}/ws/human`,
  };
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

describe('post_delta 全链路', () => {
  it('agent WS delta → 引擎校验 → 人类 WS 收到广播；stale 不广播', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_d', hash: sha256(raw), label: null, createdAt: 't' });
    const agent = new WebSocket(agentUrl);
    const agentFrames: any[] = [];
    agent.on('message', (d) => agentFrames.push(JSON.parse(String(d))));
    await new Promise<void>((r) => agent.on('open', r));
    agent.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } }));
    const human = new WebSocket(humanUrl);
    const humanFrames: any[] = [];
    human.on('message', (d) => humanFrames.push(JSON.parse(String(d))));
    await new Promise<void>((r) => human.on('open', r));
    human.send(JSON.stringify({ type: 'hello', roomId: 'lobby' }));
    await new Promise((r) => setTimeout(r, 100));

    handle.engine.humanPost('lobby', 'key_x', '阿伟', '起个头');
    const event = await next(agentFrames, 'event');
    agent.send(JSON.stringify({ type: 'post_delta', eventId: event.eventId, delta: '今天我们' }));
    agent.send(JSON.stringify({ type: 'post_delta', eventId: 'ev_stale', delta: '乱入' }));
    const delta = await next(humanFrames, 'post_delta');
    expect(delta).toEqual({ type: 'post_delta', agentId: expect.any(String), roomId: 'lobby', delta: '今天我们' });
    expect(humanFrames.filter((f) => f.type === 'post_delta')).toHaveLength(1); // stale 未广播

    // 最终 post 落库照常
    agent.send(JSON.stringify({ type: 'post', eventId: event.eventId, text: '今天我们聊聊评分' }));
    const ack = await next(agentFrames, 'ack');
    expect(ack.status).toBe('posted');
    agent.close();
    human.close();
  });
});
