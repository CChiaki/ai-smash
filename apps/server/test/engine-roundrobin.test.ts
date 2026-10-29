import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-29T10:00:00.000Z').getTime();
}

/** 轮流发言世界：新房间默认即轮流（storage 列默认值），此处显式设置以自文档 */
function roundWorld(cooldownMs = 2000) {
  const w = makeWorld({ cooldownMs } as any);
  w.storage.updateRoom('lobby', { speakMode: 'roundrobin' });
  return w;
}

describe('轮流发言（2.4）', () => {
  it('两 agent 严格交替：人类起头 → A → B → A，各自只派一个', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, 'A豆');
    const b = addAgent(w, 'B豆');
    vi.setSystemTime(t0() + 10_000);
    join(w, a.id);
    vi.setSystemTime(t0() + 11_000);
    join(w, b.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id]); // 从队首开始
    vi.advanceTimersByTime(2000); // 下一个轮到者（B）无冷却，A 的冷却到期不阻塞
    w.engine.agentPost(a.id, dispatched[0].eventId, 'A 说');
    vi.advanceTimersByTime(2000);
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id]); // A 发言后轮到 B
    w.engine.agentPost(b.id, dispatched[1].eventId, 'B 说');
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id, a.id]); // B 发言后回到 A
  });

  it('单人房：人类发言 → agent 回复后链条自然结束（自我回声硬禁），冷却过后仍接得上', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, '独豆');
    join(w, a.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '问一');
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id]);
    w.engine.agentPost(a.id, dispatched[0].eventId, '答一');
    expect(dispatched).toHaveLength(1); // 自己的发言不派发给自己 → 结束
    w.engine.humanPost('lobby', 'key_1', '阿伟', '问二'); // 轮到 A（冷却中）→ 排队
    vi.advanceTimersByTime(2000);
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, a.id]); // 锚点仍在 A，继续接
  });

  it('被 @ 点名优先插队，轮换锚点跟移到被点名者', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, 'A豆');
    const b = addAgent(w, 'B豆');
    vi.setSystemTime(t0() + 10_000);
    join(w, a.id);
    vi.setSystemTime(t0() + 11_000);
    join(w, b.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    vi.advanceTimersByTime(2100);
    w.engine.agentPost(a.id, dispatched[0].eventId, 'A 说');   // 锚点=A → 顺位派 B
    vi.advanceTimersByTime(2100);
    w.engine.agentPost(b.id, dispatched[1].eventId, 'B 说');   // 锚点=B → 轮到 A
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id, a.id]);
    vi.advanceTimersByTime(2100);
    w.engine.agentPost(a.id, dispatched[2].eventId, 'A 再说'); // 锚点=A → 派 B
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id, a.id, b.id]);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@A豆 插个队'); // @ 插队直达 A（豁免冷却/连续），锚点=A
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id, a.id, b.id, a.id]);
    vi.advanceTimersByTime(2100);
    w.engine.agentPost(b.id, dispatched[3].eventId, 'B 说');   // B 先收尾自己的在途轮次（不触发新派发：A 在途、自己回声）
    expect(dispatched).toHaveLength(5);
    vi.advanceTimersByTime(2100);
    w.engine.agentPost(a.id, dispatched[4].eventId, 'A 插队后说'); // A 发言 → B 冷却排队 → 到期补派
    vi.advanceTimersByTime(2100);
    expect(dispatched.at(-1)!.agentId).toBe(b.id);             // 轮换确实从锚点（A）之后继续
  });

  it('轮到的 agent skip → 顺延下一位（同一触发消息），不卡时限', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, 'A豆');
    const b = addAgent(w, 'B豆');
    vi.setSystemTime(t0() + 10_000);
    join(w, a.id);
    vi.setSystemTime(t0() + 11_000);
    join(w, b.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id]);
    w.engine.agentSkip(a.id, dispatched[0].eventId);
    expect(dispatched.map((f) => f.agentId)).toEqual([a.id, b.id]); // 顺延给 B，同一话题
    expect(dispatched[1].trigger.messageId).toBe(dispatched[0].trigger.messageId);
  });

  it('轮到者在冷却：轮次保留排队补派，不跳人', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, 'A豆');
    const b = addAgent(w, 'B豆');
    vi.setSystemTime(t0() + 10_000);
    join(w, a.id);
    vi.setSystemTime(t0() + 11_000);
    join(w, b.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    w.engine.agentPost(a.id, dispatched[0].eventId, 'A 说');        // A 进 2s 冷却，锚点=A
    w.engine.agentPost(b.id, dispatched[1].eventId, 'B 说');        // B 接棒，也进冷却
    vi.advanceTimersByTime(300);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '追问');            // 轮到 A（冷却中）→ 排队等 A
    vi.advanceTimersByTime(2000);
    expect(dispatched.at(-1)!.agentId).toBe(a.id);                   // 到期补派给 A（而非顺延 B）
  });

  it('换人即清零连续计数：A/B 长辩论不触发 throttled（轮流的结构公平性替代连续上限的防自嗨职责）', () => {
    vi.setSystemTime(t0());
    const w = roundWorld();
    const a = addAgent(w, 'A豆');
    const b = addAgent(w, 'B豆');
    vi.setSystemTime(t0() + 10_000);
    join(w, a.id);
    vi.setSystemTime(t0() + 11_000);
    join(w, b.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    // 八轮交替辩论，全部成功落库（旧护栏下第 4 条就会被 throttled 拒）
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(2100); // 轮到者冷却到期，交替辩论得以继续
      const ev = dispatched.at(-1)!;
      const r = w.engine.agentPost(ev.agentId, ev.eventId, `第 ${i} 轮发言`);
      expect(r.status).toBe('posted');
    }
    expect(w.storage.listMessages('lobby').filter((m) => m.senderKind === 'agent')).toHaveLength(8);
  });
});
