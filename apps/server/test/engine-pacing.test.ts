import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

describe('发言节奏调优（2.3）', () => {
  it('自我回声硬禁：A 的发言不派发给 A（与冷却无关）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 0 } as any); // 冷却归零也不得自我回声（Limits 为 as const 字面量类型，覆写需 as any，同仓内既有测试）
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    const ev = dispatched.filter((f) => f.agentId === a.id)[0];
    w.engine.agentPost(a.id, ev.eventId, '我自己的发言');
    // A 的发言广播给房间内其他 agent（无），且绝不派发给 A 自己
    expect(dispatched.every((f) => f.agentId !== a.id || f.trigger.sender.agentId !== a.id)).toBe(true);
    expect(dispatched.filter((f) => f.trigger.sender.agentId === a.id)).toHaveLength(0);
  });

  it('冷却排队：冷却期内的追问不丢失，到期自动补派', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 2000 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    const ev1 = dispatched[0];
    w.engine.agentPost(a.id, ev1.eventId, '答第一问');       // 进入 2s 冷却
    expect(dispatched).toHaveLength(1);
    vi.advanceTimersByTime(500);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问：为什么？'); // 冷却期内的追问
    expect(dispatched).toHaveLength(1);                       // 冷却中不立即派发
    vi.advanceTimersByTime(2000);                             // 冷却到期 → 自动补派
    expect(dispatched.length).toBeGreaterThanOrEqual(2);
    expect(dispatched.at(-1)!.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '追问：为什么？')[0].id,
    );
  });

  it('冷却排队多条只留最新；agentPost 清除排队定时器', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 2000 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    const ev1 = dispatched[0];
    w.engine.agentPost(a.id, ev1.eventId, '答');
    vi.advanceTimersByTime(300);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问一');
    vi.advanceTimersByTime(300);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问二'); // 覆盖追问一
    vi.advanceTimersByTime(1600);                            // 冷却到期
    const followUps = dispatched.filter((f) => f.trigger.messageId ===
      w.storage.listMessages('lobby').filter((m) => m.text === '追问一')[0]?.id);
    expect(followUps).toHaveLength(0);                       // 追问一被覆盖不派发
    expect(dispatched.at(-1)!.trigger.messageId).toBe(
      w.storage.listMessages('lobby').filter((m) => m.text === '追问二')[0].id,
    );
  });
});
