import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAgent, join, makeWorld, record } from './helpers.js';
import { Topics } from '../src/topics.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

function sysMessages(w: ReturnType<typeof makeWorld>): string[] {
  return w.storage.listMessages('lobby').filter((m) => m.senderKind === 'system').map((m) => m.text);
}

describe('@提及定向派发', () => {
  it('被 @ 的 Agent 定向收到 event，其他 Agent 不广播', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, 'post:dispatch-count') ?? [];
    void dispatched;
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 你怎么看评分？');
    expect(frames.map((f) => f.agentId)).toEqual([a.id]);
  });

  it('冷却中的 Agent 被 @ 豁免冷却，但单 Agent 速率仍生效', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000 } as any);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    // 第一轮正常发言进入冷却
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    w.engine.agentPost(a.id, frames.at(-1)!.eventId, '第一句');
    const countAfterFirst = frames.length;
    // 冷却中普通消息：不派发
    vi.setSystemTime(new Date(t0() + 1000));
    w.engine.humanPost('lobby', 'key_1', '阿伟', '普通消息不打扰');
    expect(frames.length).toBe(countAfterFirst);
    // 冷却中 @ 点名：豁免冷却，仍派发
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 被点名了，回答一下');
    expect(frames.length).toBe(countAfterFirst + 1);
  });

  it('@ 多人各自定向；@ 不存在的名字发系统消息且不广播', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 @老豆 @路人甲 都说说');
    expect(frames.map((f) => f.agentId).sort()).toEqual([a.id, b.id].sort());
    expect(sysMessages(w).some((t) => t.includes('路人甲'))).toBe(true);
  });

  it('@ 候补中的 Agent：跳过 + 系统消息「房间内没有叫 xxx 的 Agent」', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '候补豆');
    join(w, a.id);
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    join(w, b.id); // waiting
    w.storage.updateRoom('lobby', { maxAgents: 50 });
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@候补豆 你在吗');
    expect(frames).toHaveLength(0);
    expect(sysMessages(w).some((t) => t.includes('候补豆'))).toBe(true);
  });

  it('@ 离线 Agent：跳过 + 系统消息「xxx 不在线」', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.storage.setAgentStatus(a.id, 'offline', new Date().toISOString());
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 在吗');
    expect(frames).toHaveLength(0);
    expect(sysMessages(w).some((t) => t.includes('不在线'))).toBe(true);
  });

  it('在途 Agent 被 @：合并为 pending，冷却豁免随行（agent 完成当前发言后立即派发）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000 } as any);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    const mentionMsg = w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 第二问（在途合并）');
    w.engine.agentPost(a.id, frames[0].eventId, '回答第一问');
    // agentPost 后 cooldown 60s 生效；但 pending 是 @ 触发的 → 豁免冷却立即派发
    expect(frames.length).toBe(2);
    // 注意：trigger 是被 @ 的那条消息（agent 的回复消息在其之前已落库，
    // 故不能断言 listMessages 的最后一条，那会是「回答第一问」）
    expect(frames.at(-1)!.trigger.messageId).toBe(mentionMsg.id);
  });
});

// ── 测试工具：捕获真实派发帧（经 Bus 的 eventDispatch 负载）──────

function recordDispatch(w: ReturnType<typeof makeWorld>): Array<{ agentId: string; eventId: string; trigger: { messageId: string } }> {
  const got: any[] = [];
  w.bus.on(Topics.eventDispatch, (p: any) => got.push(p));
  return got;
}
