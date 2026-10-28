import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function t0(): number {
  return new Date('2026-10-28T08:00:00.000Z').getTime();
}

describe('agentDelta（流式校验与转发）', () => {
  it('在途 event 的 delta：校验通过并经 Bus 发 postDelta', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const dispatched = record(w.bus, Topics.eventDispatch);
    void dispatched;
    const eventId = w.storage.listEvents({ agentId: a.id, limit: 1 })[0]?.id
      ?? (w.bus as any).__lastEventId;
    // 直接从 events 表取在途 event id（listEvents 需要 roomId/agentId 过滤）
    const ev = w.storage.listEvents({ agentId: a.id })[0]!;
    void eventId;
    const r = w.engine.agentDelta(a.id, ev.id, '今天我们');
    expect(r.ok).toBe(true);
    expect(deltas).toEqual([{ roomId: 'lobby', agentId: a.id, delta: '今天我们' }]);
  });

  it('stale（非在途 eventId）返回 ok:false 且不发', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const r = w.engine.agentDelta(a.id, 'ev_fake', '乱入');
    expect(r.ok).toBe(false);
    expect(deltas).toHaveLength(0);
  });

  it('单 event 累计超 8000 字：超出部分拒绝', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const ev = w.storage.listEvents({ agentId: a.id })[0]!;
    expect(w.engine.agentDelta(a.id, ev.id, 'x'.repeat(7900)).ok).toBe(true);
    expect(w.engine.agentDelta(a.id, ev.id, 'x'.repeat(200)).ok).toBe(false); // 超 8000
    expect(w.engine.agentDelta(a.id, ev.id, '尾包').ok).toBe(false);          // 仍超，继续拒绝
    expect(deltas).toHaveLength(1);
  });

  it('event 终态后 delta 拒绝', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const deltas = record(w.bus, Topics.postDelta);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const dispatched = record(w.bus, Topics.eventDispatch);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起个头');
    const eventId = dispatched[0].eventId;
    w.engine.agentSkip(a.id, eventId);
    expect(w.engine.agentDelta(a.id, eventId, '迟到').ok).toBe(false);
    expect(deltas).toHaveLength(0);
  });
});
