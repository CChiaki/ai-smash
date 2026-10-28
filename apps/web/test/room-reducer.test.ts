import { describe, expect, it } from 'vitest';
import { initialRoomState, roomReducer } from '../src/room-reducer.js';
import type { ChatMessage } from '@ai-smash/protocol';

function msg(seq: number, text: string): ChatMessage {
  return { id: `m_${seq}`, roomId: 'lobby', seq, sender: { kind: 'human', name: '阿伟' }, text, replyTo: null, createdAt: 't', deletedAt: null };
}

describe('roomReducer', () => {
  it('ready 载入房间/历史/在场，并记录 you（身份/房主）', () => {
    const room = { id: 'lobby', title: '大厅', topic: null, visibility: 'public' as const, status: 'active' as const, onlineAgents: 1, maxAgents: 50, cooldownMs: 10000 };
    const next = roomReducer(initialRoomState, { type: 'ready', room, messages: [msg(1, 'a')], agents: [], you: { keyId: 'k_1', name: '阿伟', isOwner: true } });
    expect(next.ready).toBe(true);
    expect(next.room?.id).toBe('lobby');
    expect(next.messages).toHaveLength(1);
    expect(next.you?.isOwner).toBe(true);
    expect(next.you?.keyId).toBe('k_1');
  });

  it('message 按 seq 去重追加', () => {
    let s = initialRoomState;
    s = roomReducer(s, { type: 'message', message: msg(1, 'a') });
    s = roomReducer(s, { type: 'message', message: msg(1, 'a') }); // 重复
    s = roomReducer(s, { type: 'message', message: msg(2, 'b') });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('message 全量去重：重复 id 出现在中间（乱序重放）不重复追加', () => {
    let s = initialRoomState;
    s = roomReducer(s, { type: 'message', message: msg(1, 'a') });
    s = roomReducer(s, { type: 'message', message: msg(2, 'b') });
    s = roomReducer(s, { type: 'message', message: msg(3, 'c') });
    s = roomReducer(s, { type: 'message', message: msg(2, 'b') }); // 重放不在末条的 id
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('reaction 更新 likes；presence/room 直接替换', () => {
    let s = roomReducer(initialRoomState, { type: 'reaction', messageId: 'm_1', likes: 3 });
    expect(s.likes['m_1']).toBe(3);
    s = roomReducer(s, { type: 'reaction', messageId: 'm_1', likes: 4 });
    expect(s.likes['m_1']).toBe(4);
    s = roomReducer(s, { type: 'presence', agents: [] });
    expect(s.agents).toEqual([]);
    s = roomReducer(s, { type: 'reset' });
    expect(s.ready).toBe(false);
  });
});

describe('流式（2.1）', () => {
  const presence = [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null }] as any;

  it('delta 累积到 streaming（名字从 presence 解析）', () => {
    let s = roomReducer({ ...initialRoomState, agents: presence }, { type: 'presence', agents: presence });
    s = roomReducer(s, { type: 'delta', agentId: 'ag_1', delta: '今天' });
    s = roomReducer(s, { type: 'delta', agentId: 'ag_1', delta: '我们' });
    expect(s.streaming['ag_1']).toEqual({ name: '小豆', text: '今天我们' });
  });

  it('同名 agent 的 post 落库时清除其流式条目', () => {
    let s = { ...initialRoomState, agents: presence, streaming: { ag_1: { name: '小豆', text: '今天我们' } } } as any;
    s = roomReducer(s, { type: 'message', message: { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '今天我们', replyTo: null, createdAt: 't', deletedAt: null } });
    expect(s.streaming['ag_1']).toBeUndefined();
    expect(s.messages).toHaveLength(1);
  });

  it('ready 与 reset 清空 streaming', () => {
    let s = { ...initialRoomState, streaming: { ag_1: { name: 'x', text: 't' } } } as any;
    s = roomReducer(s, { type: 'ready', room: null as any, messages: [], agents: [], you: null });
    expect(s.streaming).toEqual({});
  });

  it('presence 无 thinking 时清除流式幽灵气泡（skip/timeout/rejected 终态）', () => {
    const idle = [{ agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null }] as any;
    let s = { ...initialRoomState, agents: presence, streaming: { ag_1: { name: '小豆', text: '今天我们' } } } as any;
    s = roomReducer(s, { type: 'presence', agents: idle }); // ag_1 不再 thinking → 流式条清除
    expect(s.streaming).toEqual({});
    expect(s.agents).toEqual(idle);
    // 仍 thinking 的 Agent 流式条保留
    s = { ...initialRoomState, agents: idle, streaming: { ag_1: { name: '小豆', text: 't' } } } as any;
    s = roomReducer(s, { type: 'presence', agents: presence });
    expect(s.streaming['ag_1']).toEqual({ name: '小豆', text: 't' });
  });
});
