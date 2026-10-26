import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { runScoring } from '../src/engine/score.js';
import { boot } from '../src/server.js';
import { admin, testConfig } from './http-helpers.js';

// boot() 内部 loadConfig() 从进程环境读取必需变量；测试环境补齐（同 boot.test.ts 先例，不改动 brief 源码）
process.env.ADMIN_TOKEN ??= 'test-admin-token';

const booted: Array<{ shutdown: () => Promise<void> }> = [];
afterAll(async () => { for (const h of booted) await h.shutdown(); });

async function start() {
  const h = await boot({ ...testConfig(), port: 0 });
  booted.push(h);
  const port = (h.app.server.address() as any).port;
  return { h, base: `http://127.0.0.1:${port}`, agentUrl: `ws://127.0.0.1:${port}/ws/agent`, humanUrl: `ws://127.0.0.1:${port}/ws/human` };
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

describe('E2E 冒烟：key → agent → 投喂 → 回复 → 点赞 → 评分 → 封禁', () => {
  it('全链路', async () => {
    const { h, base, agentUrl } = await start();

    // 1. 申请 key
    const keyRes = await fetch(`${base}/api/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '玩家一' }),
    });
    expect(keyRes.status).toBe(201);
    const { key: raw, id: keyId } = await keyRes.json() as any;

    // 2. agent 接入并自动进入大厅
    const ws = new WebSocket(agentUrl);
    const frames: any[] = [];
    let closedCode = 0;
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    ws.on('close', (c) => { closedCode = c; });
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '冲榜手' } }));
    const joined = await next(frames, 'joined');
    expect(joined.roomId).toBe('lobby');

    // 3. 人投喂
    const postRes = await fetch(`${base}/api/rooms/lobby/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
      body: JSON.stringify({ text: '谁来聊聊评分系统' }),
    });
    expect(postRes.status).toBe(201);

    // 4. agent 收到 event 并回复
    const event = await next(frames, 'event');
    expect(event.trigger.sender.kind).toBe('human');
    ws.send(JSON.stringify({ type: 'post', eventId: event.eventId, text: '我来聊聊：分数 = 行为 0.7 + 热度 0.3' }));
    const ack = await next(frames, 'ack');
    expect(ack.status).toBe('posted');

    // 5. 观众点赞 agent 的回复（用另一把 key）
    const likeKeyRes = await fetch(`${base}/api/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const likeKey = await likeKeyRes.json() as any;
    const agentMsg = h.storage.listMessages('lobby').find((m) => m.senderKind === 'agent')!;
    const likeRes = await fetch(`${base}/api/messages/${agentMsg.id}/reactions`, {
      method: 'POST', headers: { authorization: `Bearer ${likeKey.key}` },
    });
    expect(likeRes.status).toBe(200);
    expect((await likeRes.json() as any).likes).toBe(1);

    // 6. 评分落库
    expect(runScoring(h.storage, new Date(), DEFAULT_LIMITS)).toBeGreaterThanOrEqual(1);
    const score = h.storage.getScore(h.storage.listAgents().find((a) => a.name === '冲榜手')!.id);
    expect(score?.likes7d).toBe(1);

    // 7. 管理员封禁 → agent 断开 4003
    const ban = await fetch(`${base}/api/admin/keys/${keyId}/ban`, { method: 'POST', headers: admin() });
    expect(ban.status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(closedCode).toBe(4003);

    // 8. 被封 key 的 REST 访问 403
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${raw}` } });
    expect(me.status).toBe(403);

    ws.terminate();
  });
});
