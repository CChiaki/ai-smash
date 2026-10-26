import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { boot, type BootHandle } from '../src/server.js';
import { newId, newKey, sha256 } from '../src/ids.js';

const AGENTS = 50;
const HUMAN_KEYS = 3;
const MESSAGES_PER_KEY = 10; // humanPerMinute=10，正好打满不触发人类限速

const handles: BootHandle[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  // 先等全部 socket 真正关闭（服务端 close 回调要写 storage），再 shutdown，避免 db 已关仍在写入
  await Promise.all(
    sockets.map((s) => new Promise<void>((r) => {
      if (s.readyState === WebSocket.CLOSED) return r();
      s.once('close', () => r());
      s.terminate();
    })),
  );
  await wait(200); // 服务端 close 回调余量
  for (const h of handles) await h.shutdown();
});

interface FakeAgent {
  name: string;
  frames: any[];
  closed: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectFakeAgent(base: string, key: string, name: string): Promise<FakeAgent> {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/agent');
  sockets.push(ws);
  const agent: FakeAgent = { name, frames: [], closed: false };
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d));
    agent.frames.push(frame);
    // 自动应答：每个 event post 一条带编号的话（平台限速会拒绝超额部分）
    if (frame.type === 'event') {
      ws.send(JSON.stringify({ type: 'post', eventId: frame.eventId, text: `${name} 说：第 ${frame.context.messages.length} 条` }));
    }
  });
  ws.on('close', () => { agent.closed = true; });
  await new Promise<void>((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, key, agent: { name } }));
  // 等 ready + joined
  for (let i = 0; i < 100 && !agent.frames.some((f) => f.type === 'joined'); i++) await wait(50);
  return agent;
}

describe('50 agent 压测冒烟（真实默认护栏）', () => {
  it('限速生效、事件全部终态、事件循环无明显阻塞', { timeout: 240_000 }, async () => {
    process.env.ADMIN_TOKEN ??= 'load-admin-token';
    const dir = mkdtempSync(join(tmpdir(), 'aismash-load-'));
    const handle = await boot({ dbPath: join(dir, 'load.db'), port: 0 });
    handles.push(handle);
    const port = (handle.app.server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    // 3 把人类 key（HTTP 路径，≤ keysPerIpPerHour=10）+ 17 把 agent key
    //（keyAgentsPerRoom=3，17×3=51 ≥ 50，每 key 最多 3 个 agent 进同一房间）
    const humanKeys: string[] = [];
    for (let i = 0; i < HUMAN_KEYS; i++) {
      const res = await fetch(`${base}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      humanKeys.push((await res.json()).key);
    }
    const AGENT_KEYS = 17;
    const agentKeys: string[] = [];
    for (let i = 0; i < AGENT_KEYS; i++) {
      // 与 /api/keys 相同格式，直接落 storage 绕过 HTTP 每 IP 每小时 10 把的限速
      const raw = newKey();
      handle.storage.createKey({ id: newId('key'), hash: sha256(raw), label: `load-agent-${i}`, createdAt: new Date().toISOString() });
      agentKeys.push(raw);
    }
    const agents: FakeAgent[] = [];
    for (let i = 0; i < AGENTS; i++) {
      agents.push(await connectFakeAgent(base, agentKeys[i % AGENT_KEYS], `压测豆${i}`));
    }
    expect(agents.filter((a) => a.frames.some((f) => f.type === 'joined'))).toHaveLength(AGENTS);

    // 事件循环阻塞采样：每 500ms 记录一次漂移
    let maxDrift = 0;
    const driftTimer = setInterval(() => {
      const start = Date.now();
      setImmediate(() => { maxDrift = Math.max(maxDrift, Date.now() - start); });
    }, 500);
    driftTimer.unref?.();

    // 3 key × 10 条，间隔 6s（>60s 总时长内 humanPerMinute 不越限）
    for (let n = 0; n < MESSAGES_PER_KEY; n++) {
      for (let k = 0; k < HUMAN_KEYS; k++) {
        const res = await fetch(`${base}/api/rooms/lobby/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${humanKeys[k]}` },
          body: JSON.stringify({ text: `压测投喂 ${n}-${k}` }),
        });
        expect(res.status).toBe(201);
      }
      await wait(6000);
    }

    // 收尾：等最后一个事件波次全部到终态（最坏 deadline 20s + 派发余量）
    await wait(30_000);

    // 断言 1：全部事件到达终态（无永久 delivered）
    const pending = handle.storage.listEvents({ limit: 10_000 }).filter((e) => e.status === 'delivered');
    expect(pending).toHaveLength(0);

    // 断言 2：房间 agent 消息速率被限速压制（任意 10s 窗口 ≤ 5 条 + 边界容差 2）
    const agentMsgs = handle.storage.listMessages('lobby', { limit: 10_000 }).filter((m) => m.senderKind === 'agent');
    const times = agentMsgs.map((m) => new Date(m.createdAt).getTime()).sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      const window = times.filter((t) => t >= times[i] && t < times[i] + 10_000);
      expect(window.length).toBeLessThanOrEqual(7);
    }
    // 且限速确实生效过（50 个 agent 抢 5 条/10s，必然出现 rejected throttled）
    const throttled = handle.storage.listEvents({ limit: 10_000 }).filter((e) => e.reason === 'throttled');
    expect(throttled.length).toBeGreaterThan(0);

    // 断言 3：事件循环无阻塞（采样期内最大漂移 < 2s）
    clearInterval(driftTimer);
    expect(maxDrift).toBeLessThan(2000);

    // 关键压测数字（供报告/回归对照）
    const maxWindow = Math.max(...times.map((t) => times.filter((x) => x >= t && x < t + 10_000).length), 0);
    console.log(`[load-smoke] agent 消息 ${agentMsgs.length} 条 | 10s 窗口峰值 ${maxWindow} | throttled 事件 ${throttled.length} | 事件总数 ${handle.storage.listEvents({ limit: 10_000 }).length} | 最大漂移 ${maxDrift}ms`);

    // 断言 4：评分任务能跑完且全员有分（或评分中）
    const { runScoring } = await import('../src/engine/score.js');
    const { DEFAULT_LIMITS } = await import('@ai-smash/protocol');
    const scored = runScoring(handle.storage, new Date(), DEFAULT_LIMITS);
    expect(scored).toBeGreaterThan(0);
    console.log(`[load-smoke] 本轮评分 agent 数 ${scored}`);
  });
});
