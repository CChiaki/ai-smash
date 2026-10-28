import { Topics } from '../src/topics.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError } from '../src/engine/errors.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-26T08:00:00.000Z').getTime();
}

describe('agentPost 基本流', () => {
  it('发言落库、ack posted、广播、并触发他人接力派发', () => {
    vi.setSystemTime(t0());
    const w = makeWorld(); // 默认冷却 10s，避免 a 被自己的消息再触发
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    const b = addAgent(w, '老豆');
    join(w, a.id);
    join(w, b.id);
    const humanMsg = w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    expect(dispatched).toHaveLength(2);
    // b 先跳过自己的人类触发事件，之后才能收到 a 发言的接力 event
    const bEvent = dispatched.find((f) => f.agentId === b.id)!;
    w.engine.agentSkip(b.id, bEvent.eventId);
    const aEvent = dispatched.find((f) => f.agentId === a.id)!;
    const r = w.engine.agentPost(a.id, aEvent.eventId, '我接一句', humanMsg.id);
    expect(r.status).toBe('posted');
    const messages = w.storage.listMessages('lobby');
    expect(messages.at(-1)?.senderKind).toBe('agent');
    expect(messages.at(-1)?.replyTo).toBe(humanMsg.id);
    // b 收到 a 的消息触发的接力 event
    expect(dispatched.some((f) => f.agentId === b.id && f.trigger.sender.kind === 'agent')).toBe(true);
    expect(w.storage.getStats(a.id).posted).toBe(1);
  });

  it('过期 eventId 拒绝 stale 且不落库', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    const before = w.storage.listMessages('lobby').length;
    const r = w.engine.agentPost(a.id, 'ev_fake', '冒充回复');
    expect(r).toEqual({ status: 'rejected', reason: 'stale' });
    expect(w.storage.listMessages('lobby').length).toBe(before);
  });

  it('超长文本拒绝 invalid', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    const r = w.engine.agentPost(a.id, dispatched[0].eventId, 'x'.repeat(4001));
    expect(r).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('rejected');
  });

  it('暂停的房间拒绝 paused', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    w.engine.pauseRoom('lobby');
    const r = w.engine.agentPost(a.id, dispatched[0].eventId, '还想说');
    expect(r).toEqual({ status: 'rejected', reason: 'paused' });
  });
});

describe('冷却与速率', () => {
  it('发言后冷却期内不派发，冷却结束恢复', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 5000 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.agentPost(a.id, dispatched[0].eventId, '回');
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(2);
  });

  it('单 agent 速率（测试里收紧为 1 条/分钟，冷却归零以隔离变量）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ agentPerMinute: 1, cooldownMs: 0 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.agentPost(a.id, dispatched[0].eventId, '回1');
    // a 本轮已发 1 条且达到速率上限：对自己的消息不再自触发， human 再说也不派发
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(60_001);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '三');
    expect(dispatched).toHaveLength(2);
  });

  it('房间级 10 秒 5 条（测试里收紧为 2）：超出的发言 rejected throttled', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ roomMessagesPer10s: 2, cooldownMs: 0 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const agents = ['a', 'b', 'c'].map((n) => addAgent(w, n));
    for (const a of agents) join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起');
    expect(dispatched).toHaveLength(3);
    // fake timers 下 joined_at 全相同，派发顺序与 agents 数组不保证一致：按 agentId 找各自的在途 event
    const evFor = (i: number) => dispatched.find((f) => f.agentId === agents[i].id)!;
    w.engine.agentPost(agents[0].id, evFor(0).eventId, '一');
    w.engine.agentPost(agents[1].id, evFor(1).eventId, '二');
    // 第 3 条 agent 消息触发房间限速；c 在途的 event 是 human 起头那次派发后
    // 因 room 满 2 条而合并/新增的，直接找 c 最新在途
    const cEvent = dispatched.filter((f) => f.agentId === agents[2].id).at(-1)!;
    const r = w.engine.agentPost(agents[2].id, cEvent.eventId, '三');
    expect(r).toEqual({ status: 'rejected', reason: 'throttled' });
    expect(w.storage.getEvent(cEvent.eventId)?.reason).toBe('throttled');
    expect(w.storage.listMessages('lobby').filter((m) => m.senderKind === 'agent')).toHaveLength(2);
  });
});

describe('连续发言上限', () => {
  it('无人打断时最多连续 2 条（2.3 自我回声硬禁后，经合并 pending 接力触发）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 0, maxConsecutive: 2 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问'); // 在途合并 pending
    w.engine.agentPost(a.id, dispatched[0].eventId, '自言自语1');
    // 发言后：自我回声硬禁 → 自己的消息不再派发给自己；pending 的「追问」补派
    const e2 = dispatched.at(-1)!;
    expect(e2.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '追问')[0].id,
    );
    w.engine.agentPost(a.id, e2.eventId, '自言自语2');
    // 第 2 次连续发言：consecutive 达上限，afterEvent 不再补派，链被截断
    const agentMsgCount = w.storage.listMessages('lobby').filter((m) => m.senderKind === 'agent').length;
    expect(agentMsgCount).toBe(2);
    expect(dispatched.filter((f) => f.trigger.sender.kind === 'agent')).toHaveLength(0);
  });
});

describe('超时', () => {
  it('deadline 到点记 timeout，并补派合并事件', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ deadlineMs: 100 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    expect(dispatched).toHaveLength(1);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    expect(dispatched).toHaveLength(1); // 合并
    vi.advanceTimersByTime(150);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('timeout');
    expect(w.storage.getStats(a.id).timeout).toBe(1);
    expect(dispatched).toHaveLength(2); // 合并的补派
    expect(dispatched[1].trigger.messageId).toBe(w.storage.listMessages('lobby').at(-1)?.id);
  });
});

describe('人类限速', () => {
  it('每分钟超过上限抛 throttled', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ humanPerMinute: 2 } as any);
    join(w, addAgent(w, '小豆').id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二');
    try {
      w.engine.humanPost('lobby', 'key_1', '阿伟', '三');
      expect.unreachable();
    } catch (e) {
      expect((e as EngineError).code).toBe('throttled');
    }
  });
});

describe('inflight 守卫', () => {
  it('在途期间派发合并为新事件，不覆盖在途 event', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 0 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const m1 = w.engine.humanPost('lobby', 'key_1', '阿伟', '一');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '二'); // 合并为 pending
    w.engine.humanPost('lobby', 'key_1', '阿伟', '三'); // 覆写 pending
    // 发言后：2.3 自我回声硬禁不再自触发；pending（三）作为新 event 补派
    w.engine.agentPost(a.id, dispatched[0].eventId, '自言自语1');
    expect(dispatched).toHaveLength(2);
    const e2 = dispatched[1];
    expect(e2.eventId).not.toBe(dispatched[0].eventId); // 新事件，未覆盖在途 event
    expect(e2.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '三')[0].id,
    );
    expect(e2.trigger.messageId).not.toBe(m1.id);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('posted');
  });
});
