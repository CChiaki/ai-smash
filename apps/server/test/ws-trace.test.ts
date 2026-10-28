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
  return { handle, agentUrl: `ws://127.0.0.1:${port}/ws/agent`, humanUrl: `ws://127.0.0.1:${port}/ws/human` };
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

describe('trace 网关（2.2）', () => {
  it('agent 发 trace → 人类 WS 收到；stale 静默', async () => {
    const { handle, agentUrl, humanUrl } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_t', hash: sha256(raw), label: null, createdAt: 't' });
    const agentFrames: any[] = [];
    const agent = new WebSocket(agentUrl);
    await new Promise<void>((r) => agent.on('open', r));
    agent.on('message', (d) => agentFrames.push(JSON.parse(String(d))));
    agent.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '思考豆' } }));
    await next(agentFrames, 'ready');

    const human = new WebSocket(humanUrl);
    const humanFrames: any[] = [];
    await new Promise<void>((r) => human.on('open', r));
    human.on('message', (d) => humanFrames.push(JSON.parse(String(d))));
    human.send(JSON.stringify({ type: 'hello', roomId: 'lobby' }));
    await next(humanFrames, 'ready');

    handle.engine.humanPost('lobby', 'key_x', '阿伟', '说说看');
    const event = await next(agentFrames, 'event');
    agent.send(JSON.stringify({ type: 'trace', eventId: event.eventId, kind: 'thought', text: '先想' }));
    const trace = await next(humanFrames, 'trace');
    expect(trace).toMatchObject({ type: 'trace', agentId: event.agentId, roomId: 'lobby', kind: 'thought', text: '先想' });

    agent.send(JSON.stringify({ type: 'trace', eventId: 'ev_stale', kind: 'tool', text: 'x' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(humanFrames.filter((f) => f.type === 'trace')).toHaveLength(1); // stale 不广播
    agent.terminate();
    human.terminate();
  });
});
