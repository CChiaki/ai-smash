import { describe, expect, it } from 'vitest';
import {
  AgentClientSchema, AgentPresenceSchema, AgentServerSchema, AttachmentSchema,
  BridgeChildOutputSchema, ChatMessageSchema, DEFAULT_LIMITS, HumanServerSchema,
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
    if (frame.type === 'ack') expect(frame.status).toBe('rejected');
  });

  it('解析 joined 帧', () => {
    const frame = AgentServerSchema.parse({ type: 'joined', roomId: 'lobby', status: 'waiting' });
    expect(frame.type).toBe('joined');
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

describe('post_delta 帧（2.1 流式）', () => {
  it('AgentClient post_delta：eventId + delta', () => {
    const f = AgentClientSchema.parse({ type: 'post_delta', eventId: 'ev_1', delta: '今天' });
    expect(f.type).toBe('post_delta');
  });
  it('delta 空串或超 2000 字拒绝', () => {
    expect(() => AgentClientSchema.parse({ type: 'post_delta', eventId: 'e', delta: '' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'post_delta', eventId: 'e', delta: 'x'.repeat(2001) })).toThrow();
  });
  it('HumanServer post_delta：agentId + roomId + delta', () => {
    const f = HumanServerSchema.parse({ type: 'post_delta', agentId: 'ag_1', roomId: 'lobby', delta: '今天' });
    expect(f.type).toBe('post_delta');
  });
});

describe('trace 帧（2.2）', () => {
  it('AgentClient trace：eventId + kind + text', () => {
    const f = AgentClientSchema.parse({ type: 'trace', eventId: 'ev_1', kind: 'thought', text: '先查一下资料' });
    expect(f.type).toBe('trace');
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'other', text: 'x' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'tool', text: '' })).toThrow();
    expect(() => AgentClientSchema.parse({ type: 'trace', eventId: 'e', kind: 'tool', text: 'x'.repeat(2001) })).toThrow();
  });
  it('HumanServer trace：agentId + roomId + kind + text', () => {
    const f = HumanServerSchema.parse({ type: 'trace', agentId: 'ag_1', roomId: 'lobby', kind: 'tool', text: 'search()' });
    expect(f.type).toBe('trace');
  });
  it('AgentPresence 增 mentioned 可选字段', () => {
    const f = AgentPresenceSchema.parse({ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: null, score: null, mentioned: true });
    expect((f as any).mentioned).toBe(true);
    expect(AgentPresenceSchema.parse({ agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null }).mentioned).toBeUndefined();
  });
});

describe('Attachment 附件（2.3-2.5）', () => {
  it('ChatMessage 携带 attachments', () => {
    const m = ChatMessageSchema.parse({
      id: 'm_1', roomId: 'r', seq: 1,
      sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' },
      text: '看图', replyTo: null, createdAt: 't', deletedAt: null,
      attachments: [{ kind: 'image', url: 'https://x.com/a.png' }],
    });
    expect(m.attachments).toHaveLength(1);
  });
  it('image 必须二选一：url 或 base64，都无或都有拒绝', () => {
    const base = { kind: 'image' };
    expect(() => AttachmentSchema.parse({ ...base, url: 'https://x.com/a.png' })).toBeTruthy();
    expect(() => AttachmentSchema.parse({ ...base, base64: 'aGVsbG8=' })).toBeTruthy();
    expect(() => AttachmentSchema.parse(base)).toThrow();
    expect(() => AttachmentSchema.parse({ ...base, url: 'u', base64: 'b' })).toThrow();
  });
  it('audio/video 仅 url', () => {
    expect(() => AttachmentSchema.parse({ kind: 'audio', url: 'https://x.com/a.mp3' })).toBeTruthy();
    expect(() => AttachmentSchema.parse({ kind: 'video', base64: 'b' })).toThrow();
  });
  it('超 4 个附件拒绝', () => {
    const a = { kind: 'image', url: 'u' };
    const m = { id: 'm', roomId: 'r', seq: 1, sender: { kind: 'agent', name: 'x' }, text: '', replyTo: null, createdAt: 't', deletedAt: null, attachments: Array(5).fill(a) };
    expect(() => ChatMessageSchema.parse(m)).toThrow();
  });
});
