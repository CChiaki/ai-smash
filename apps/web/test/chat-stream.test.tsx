// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@ai-smash/protocol';
import { ChatStream } from '../src/components/ChatStream.js';

afterEach(cleanup);

const agentMsg: ChatMessage = { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '正式发言', replyTo: null, createdAt: 't', deletedAt: null };
const humanMsg: ChatMessage = { id: 'm_2', roomId: 'r', seq: 2, sender: { kind: 'human', name: '阿伟' }, text: '@小豆 你怎么看 @老豆', replyTo: null, createdAt: 't', deletedAt: null };

describe('ChatStream 2.1', () => {
  it('渲染流式气泡（streaming 条目带 typing 光标类）', () => {
    render(<ChatStream messages={[]} likes={{}} streaming={{ ag_1: { name: '小豆', text: '正在生成…' } }} />);
    expect(screen.getByText('正在生成…')).toBeTruthy();
    expect(document.querySelector('.chat-msg.streaming')).toBeTruthy();
  });

  it('post 落库后流式条目消失（由调用方清除 streaming）', () => {
    render(<ChatStream messages={[agentMsg]} likes={{}} streaming={{}} />);
    expect(screen.getByText('正式发言')).toBeTruthy();
    expect(screen.queryByText('正在生成…')).toBeNull();
  });

  it('人类消息中的 @名字 高亮为 mention span', () => {
    render(<ChatStream messages={[humanMsg]} likes={{}} />);
    const mentions = document.querySelectorAll('.mention');
    expect(mentions.length).toBe(2);
  });
});

describe('ChatStream 2.3 附件', () => {
  it('渲染图片/音频/视频附件', () => {
    const mk = (kind: string, extra: Record<string, unknown>) => ({
      id: `m_${kind}`, roomId: 'r', seq: 1,
      sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' },
      text: `带${kind}`, replyTo: null, createdAt: 't', deletedAt: null,
      attachments: [extra],
    });
    render(<ChatStream messages={[
      mk('image', { kind: 'image', url: 'https://x.com/a.png' }),
      mk('audio', { kind: 'audio', url: 'https://x.com/a.mp3' }),
      mk('video', { kind: 'video', url: 'https://x.com/a.mp4' }),
    ] as any} likes={{}} />);
    expect(screen.getByRole('img')).toBeTruthy();
    expect(document.querySelector('audio')).toBeTruthy();
    expect(document.querySelector('video')).toBeTruthy();
  });

  it('base64 图片渲染为 data URI 且拒绝 svg', () => {
    render(<ChatStream messages={[
      { id: 'm_b', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: 'base64 图', replyTo: null, createdAt: 't', deletedAt: null, attachments: [{ kind: 'image', base64: 'aGVsbG8=' }] },
    ] as any} likes={{}} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.src.startsWith('data:image/')).toBe(true);
    expect(img.src).not.toContain('svg');
  });

  it('svg base64 不会以 image/svg 渲染', () => {
    // PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci = <svg xmlns="http://www.w3.org/2000/svg"
    render(<ChatStream messages={[
      { id: 'm_s', roomId: 'r', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: 'svg 图', replyTo: null, createdAt: 't', deletedAt: null, attachments: [{ kind: 'image', base64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci' }] },
    ] as any} likes={{}} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.src).not.toContain('image/svg');
  });
});
