import { Topics } from '../src/topics.js';
import { runScoring } from '../src/engine/score.js';
import { describe, expect, it } from 'vitest';
import { addAgent, join, makeWorld, record } from './helpers.js';

it('两个 agent 一轮完整对话：派发/接力/合并/评分联动', () => {
  // brief 原文为 makeWorld({ cooldownMs: 0 })；Limits 为 as const 字面量类型，
  // 与仓内既有测试一致需加 as any（见 engine-guardrails.test.ts）。
  const w = makeWorld({ cooldownMs: 0 } as any);
  const dispatched = record(w.bus, Topics.eventDispatch);
  const presenceUpdates = record(w.bus, Topics.presence);
  const a = addAgent(w, '小豆');
  const b = addAgent(w, '老豆');
  join(w, a.id);
  join(w, b.id);

  // 人起头 → 两人各收到一次派发
  const human = w.engine.humanPost('lobby', 'key_1', '阿伟', '今晚聊点什么');
  expect(dispatched).toHaveLength(2);

  // b 先跳过，a 再发言；b 无在途，直接收到 a 消息触发的接力 event
  const bHumanEvent = dispatched.find((f) => f.agentId === b.id)!;
  w.engine.agentSkip(b.id, bHumanEvent.eventId);
  const aHumanEvent = dispatched.find((f) => f.agentId === a.id)!;
  const r = w.engine.agentPost(a.id, aHumanEvent.eventId, '聊 agent 评分吧');
  expect(r.status).toBe('posted');

  const bRelay = dispatched.filter((f) => f.agentId === b.id).at(-1)!;
  expect(bRelay.trigger.sender.kind).toBe('agent');
  expect(bRelay.trigger.sender.name).toBe('小豆');

  // b 回复 a 的消息 → a 的 repliesReceived 增加
  const aMsg = w.storage.listMessages('lobby').find((m) => m.agentId === a.id)!;
  w.engine.agentPost(b.id, bRelay.eventId, '同意', aMsg.id);
  expect(w.storage.getStats(a.id).repliesReceived).toBe(1);

  // 在场列表事件随成员变化发出
  expect(presenceUpdates.length).toBeGreaterThan(0);

  // 评分联动
  expect(runScoring(w.storage, new Date(), w.limits)).toBe(2);
  const scores = w.storage.topScores(2);
  expect(scores).toHaveLength(2);
  for (const s of scores) expect(s.tier).toBe('scoring');
});

it('重启恢复：未决 event 记为 timeout', () => {
  const w = makeWorld();
  const a = addAgent(w, '小豆');
  join(w, a.id);
  w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
  const n = w.storage.markAllDeliveredAsTimeout(new Date().toISOString());
  expect(n).toBe(1);
  expect(w.storage.getStats(a.id).timeout).toBe(0); // stats 由 finishEvent 维护，重启路径不重复计数
});
