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
