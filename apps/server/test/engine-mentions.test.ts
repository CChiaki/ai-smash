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

  it('@ 在途合并的延续派发 events 带 mentioned=true', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000 } as any);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '第一问');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 第二问（在途合并）');
    w.engine.agentPost(a.id, frames[0].eventId, '回答第一问');
    // agentPost 后 cooldown 60s 生效；但 pending 是 @ 触发的 → 豁免冷却立即派发
    expect(frames.length).toBe(2);
    // 延续派发带 mentioned 归因
    expect(w.storage.getEvent(frames.at(-1)!.eventId)?.mentioned).toBe(true);
  });

  it('速率受限导致 mention-pending 丢弃时，bypass 不残留到下一轮普通派发', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000, roomMessagesPer10s: 50, agentPerMinute: 6 } as any); // 2.3 默认 30，显式收紧保持原「速率受限」语义
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    // 5 轮 @ 点名 + 发言：把 a 的速率填到 5/6（每轮人类消息重置连续计数）
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');
    w.engine.agentPost(a.id, frames.at(-1)!.eventId, '回答起头');
    for (let i = 0; i < 4; i++) {
      w.engine.humanPost('lobby', 'key_1', '阿伟', `@小豆 第 ${i} 问`);
      w.engine.agentPost(a.id, frames.at(-1)!.eventId, `回答 ${i}`);
    }
    // 第 6 条派发（速率 5/6 仍放行），a 进入在途
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 第 5 问');
    // 在途合并：pending + bypass 落下
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 追问（在途合并）');
    // a 发言后速率满 6/6：afterEvent 里 pending 因速率受限被静默丢弃
    w.engine.agentPost(a.id, frames.at(-1)!.eventId, '回答第 5 问');
    expect(frames.length).toBe(6);
    // 推进时间让冷却与速率窗口过期，普通消息恢复广播
    vi.advanceTimersByTime(61_000);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '普通一问');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '在途期间的第二问');
    expect(frames.length).toBe(7);
    // 若 bypass 残留（旧 bug），agentPost 后的延续派发会带陈旧豁免穿透冷却 → 多出一帧
    w.engine.agentPost(a.id, frames.at(-1)!.eventId, '回答普通一问');
    expect(frames.length).toBe(7); // 冷却中的普通 pending 不派发
    // a 最新 event 仍是普通广播派发，无 mentioned 标记
    expect(w.storage.listEvents({ agentId: a.id, limit: 1 })[0]?.mentioned ?? false).toBe(false);
  });
  it('mention-pending 被普通消息覆写后，bypass 不残留（回归）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld({ cooldownMs: 60_000, roomMessagesPer10s: 50 } as any);
    const frames = recordDispatch(w);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '起头');                    // A 收 event（在途）
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 先答这个');           // 合并 pending=@msg + bypass
    w.engine.humanPost('lobby', 'key_1', '阿伟', '普通消息（覆写 pending）');  // 覆写 pending，bypass 应清零
    w.engine.agentPost(a.id, frames.filter((f) => f.agentId === a.id).at(-1)!.eventId, '我答完了');
    // A 完成当前轮：pending（普通消息）按常规语义处理——冷却中且无 bypass → 不派发
    expect(frames.filter((f) => f.agentId === a.id)).toHaveLength(1);
    // 若普通消息被派发，其 event 不得带 mentioned 归因（此处未派发即无此 event）
  });

  it('邮箱式 a@b.com 不算点名，消息正常广播', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const frames = recordDispatch(w);
    const a = addAgent(w, 'b');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '我的邮箱 a@b.com');
    expect(frames).toHaveLength(1);          // 正常广播给 b（非定向）
    expect(frames[0].agentId).toBe(a.id);
    expect(w.storage.listMessages('lobby').at(-1)?.text).toContain('a@b.com');
  });

  it('候补态 agent 被点名：不直派，给系统提示（与 canDispatch 同源判定，M3）', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    const frames = recordDispatch(w);
    w.storage.setAgentStatus(a.id, 'waiting', new Date().toISOString());
    w.engine.humanPost('lobby', 'key_1', '阿伟', '@小豆 在吗');
    expect(frames).toHaveLength(0);          // 候补不得绕过 canDispatch 直派
    expect(sysMessages(w).some((t) => t.includes('不在线'))).toBe(true);
  });

  it('中文无空格点名：你好@小豆 触发定向派发，邮箱仍不误伤', () => {
    vi.setSystemTime(t0());
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    const b = addAgent(w, 'b');
    join(w, a.id);
    join(w, b.id);
    const frames = recordDispatch(w);
    w.engine.humanPost('lobby', 'key_1', '阿伟', '你好@小豆 评一下');
    expect(frames.map((f) => f.agentId)).toEqual([a.id]);   // 定向给小豆，不广播
    w.engine.agentPost(a.id, frames[0].eventId, '好');
    w.engine.humanPost('lobby', 'key_1', '阿伟', '看 test@example.com 这个邮箱');
    // 邮箱不算点名：b 正常广播收到；a 刚发言在冷却中 → 走排队不即时派发（2.3 冷却排队语义）
    expect(frames).toHaveLength(2);
    expect(frames[1].agentId).toBe(b.id);
    expect(w.storage.listMessages('lobby').filter((m) => m.senderKind === 'system')).toHaveLength(0); // 无「没有叫 ×」误报
  });
});

// ── 测试工具：捕获真实派发帧（经 Bus 的 eventDispatch 负载）──────

function recordDispatch(w: ReturnType<typeof makeWorld>): Array<{ agentId: string; eventId: string; trigger: { messageId: string } }> {
  const got: any[] = [];
  w.bus.on(Topics.eventDispatch, (p: any) => got.push(p));
  return got;
}
