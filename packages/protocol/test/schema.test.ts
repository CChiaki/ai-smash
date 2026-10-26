import { describe, expect, it } from 'vitest';
import {
  AgentClientSchema, AgentServerSchema, BridgeChildOutputSchema,
  DEFAULT_LIMITS,
} from '../src/index.js';

describe('AgentClientSchema', () => {
  it('解析合法 hello', () => {
    const frame = AgentClientSchema.parse({
      type: 'hello', protocol: 1, key: 'sk_x', agent: { name: '小豆' },
    });
    expect(frame.type).toBe('hello');
  });

  it('拒绝错误 protocol 版本', () => {
    expect(() =>
      AgentClientSchema.parse({ type: 'hello', protocol: 2, key: 'sk_x', agent: { name: 'a' } }),
    ).toThrow();
  });

  it('拒绝超长文本 post', () => {
    expect(() =>
      AgentClientSchema.parse({ type: 'post', eventId: 'e', text: 'x'.repeat(4001) }),
    ).toThrow();
  });
});

describe('AgentServerSchema', () => {
  it('解析 event 帧', () => {
    const frame = AgentServerSchema.parse({
      type: 'event',
      eventId: 'ev_1',
      roomId: 'lobby',
      trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
      room: { title: '大厅', topic: null },
      context: {
        messages: [{
          id: 'm_1', roomId: 'lobby', seq: 1,
          sender: { kind: 'human', name: '阿伟' },
          text: 'hi', replyTo: null, createdAt: '2026-10-26T00:00:00.000Z', deletedAt: null,
        }],
        truncated: false,
      },
      deadlineAt: '2026-10-26T00:00:20.000Z',
    });
    expect(frame.type).toBe('event');
  });

  it('解析带 rejected reason 的 ack', () => {
    const frame = AgentServerSchema.parse({
      type: 'ack', eventId: 'ev_1', status: 'rejected', reason: 'stale',
    });
    expect(frame.status).toBe('rejected');
  });
});

describe('BridgeChildOutputSchema', () => {
  it('解析 post / skip / typing', () => {
    expect(BridgeChildOutputSchema.parse({ action: 'typing' }).action).toBe('typing');
    expect(BridgeChildOutputSchema.parse({ action: 'post', text: 'hi' }).action).toBe('post');
    expect(BridgeChildOutputSchema.parse({ action: 'skip' }).action).toBe('skip');
  });
});

describe('DEFAULT_LIMITS', () => {
  it('与规格一致', () => {
    expect(DEFAULT_LIMITS.cooldownMs).toBe(10_000);
    expect(DEFAULT_LIMITS.contextBytes).toBe(32_768);
    expect(DEFAULT_LIMITS.deadlineMs).toBe(20_000);
    expect(DEFAULT_LIMITS.maxConsecutive).toBe(2);
    expect(DEFAULT_LIMITS.lobbyMaxAgents).toBe(50);
    expect(DEFAULT_LIMITS.scoreWindowMs).toBe(604_800_000);
  });
});