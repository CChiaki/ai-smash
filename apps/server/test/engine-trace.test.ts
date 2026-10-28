import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

function post(w: ReturnType<typeof makeWorld>, text: string): void {
  w.engine.humanPost('lobby', 'key_1', '阿伟', text);
}

describe('agentTrace（2.2）', () => {
  it('在途 event 可上报 trace 并经 Bus 转发；不落库', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const traces = record(w.bus, Topics.trace);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '起个头');
    expect(w.engine.agentTrace(a.id, dispatched[0].eventId, 'thought', '先想想')).toBe(true);
    expect(w.engine.agentTrace(a.id, dispatched[0].eventId, 'tool', 'search()')).toBe(true);
    expect(traces.map((t: any) => t.text)).toEqual(['先想想', 'search()']);
    expect(traces[0]).toMatchObject({ roomId: 'lobby', agentId: a.id, kind: 'thought' });
  });
  it('stale eventId 静默拒绝', () => {
    const w = makeWorld();
    const traces = record(w.bus, Topics.trace);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    expect(w.engine.agentTrace(a.id, 'ev_fake', 'thought', 'x')).toBe(false);
    expect(traces).toHaveLength(0);
  });
  it('单 event 最多 20 条，超出丢弃；新派发重新计数', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const traces = record(w.bus, Topics.trace);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '第一问');
    const e1 = dispatched[0].eventId;
    for (let i = 0; i < 25; i++) w.engine.agentTrace(a.id, e1, 'thought', `t${i}`);
    expect(traces).toHaveLength(20); // 锁定滚动上限
    expect(w.engine.agentTrace(a.id, e1, 'thought', 'x')).toBe(false); // 锁定超限拒绝
    w.engine.agentSkip(a.id, e1);
    post(w, '第二问');
    const e2 = dispatched.filter((f) => f.agentId === a.id)[1].eventId;
    expect(w.engine.agentTrace(a.id, e2, 'thought', '新一轮')).toBe(true);
  });
});

describe('presence.mentioned（被点名徽章）', () => {
  it('@ 定向派发期间 mentioned=true，事件终态后清除', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '@小豆 你说');
    expect(dispatched).toHaveLength(1);
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)).toMatchObject({ mentioned: true });
    w.engine.agentSkip(a.id, dispatched[0].eventId);
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)?.mentioned ?? false).toBe(false);
  });
  it('常规广播派发不带 mentioned', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '普通消息');
    expect(w.engine.listPresence('lobby').find((p) => p.agentId === a.id)?.mentioned).toBeUndefined();
  });
});
