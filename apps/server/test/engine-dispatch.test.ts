import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

describe('humanPost → 派发', () => {
  it('消息落库、广播、向在线 agent 派发 event', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const posted = record(w.bus, Topics.messageNew);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const msg = w.engine.humanPost('lobby', 'key_1', '阿伟', '大家好');
    expect(msg.seq).toBe(1);
    expect(posted).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    const frame = dispatched[0];
    expect(frame.agentId).toBe(a.id);
    expect(frame.trigger.messageId).toBe(msg.id);
    expect(frame.context.messages.at(-1).text).toBe('大家好');
    expect(frame.context.truncated).toBe(false);
    expect(frame.deadlineAt).toBeTruthy();
    expect(w.storage.getEvent(frame.eventId)?.status).toBe('delivered');
    expect(w.storage.getStats(a.id).delivered).toBe(1);
  });

  it('离线 agent 不派发', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    w.storage.setAgentStatus(a.id, 'offline', new Date().toISOString());
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '在吗');
    expect(dispatched).toHaveLength(0);
  });
});

describe('合并派发（单在途）', () => {
  it('在途期间的新消息合并，ack 后补派一次', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const m1 = w.engine.humanPost('lobby', 'key_1', '阿伟', '第一条');
    const m2 = w.engine.humanPost('lobby', 'key_1', '阿伟', '第二条');
    expect(dispatched).toHaveLength(1); // 第二条被合并
    const r = w.engine.agentSkip(a.id, dispatched[0].eventId);
    expect(r.status).toBe('skipped');
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].trigger.messageId).toBe(m2.id);
    expect(dispatched[1].context.messages.at(-1).id).toBe(m2.id);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('skipped');
  });

  it('发言后冷却期内的合并事件被丢弃', () => {
    const w = makeWorld({ cooldownMs: 60_000 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一条');
    w.engine.agentPost(a.id, dispatched[0].eventId, '我来说两句');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第二条');
    // 冷却中：合并事件不应派发
    expect(dispatched).toHaveLength(1);
  });
});

describe('上下文预算', () => {
  it('超过字节预算时从旧到新裁剪并标记 truncated', () => {
    // Limits 为 as const 字面量类型，覆写数值需放宽（申报的最小 as any）
    const w = makeWorld({ contextBytes: 800 } as any);
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    // 6 条消息，agent 从不回应：第一条即时派发，其余全部合并
    for (let i = 0; i < 6; i++) {
      w.engine.humanPost('lobby', 'key_1', '阿伟', `消息${i}`.padEnd(63, '字'));
    }
    expect(dispatched).toHaveLength(1);
    w.engine.agentSkip(a.id, dispatched[0].eventId);
    const frame = dispatched.at(-1);
    expect(frame.context.truncated).toBe(true);
    expect(frame.context.messages.length).toBeLessThan(6);
    const bytes = Buffer.byteLength(JSON.stringify(frame.context.messages), 'utf8');
    expect(bytes).toBeLessThanOrEqual(800);
  });
});

describe('resumeRoom 补派发', () => {
  it('暂停期间不派发，恢复后以最新消息补一次', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.pauseRoom('lobby');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '暂停中也说话');
    expect(dispatched).toHaveLength(0);
    w.engine.resumeRoom('lobby');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].context.messages.at(-1).text).toBe('暂停中也说话');
  });
});
