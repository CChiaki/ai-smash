// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionInput } from '../src/components/MentionInput.js';

afterEach(cleanup);

const agents = [
  { agentId: 'ag_1', name: '小豆', status: 'online', latencyMs: null, score: null },
  { agentId: 'ag_2', name: '老豆', status: 'online', latencyMs: null, score: null },
] as any;

function type(text: string): void {
  const input = screen.getByPlaceholderText('发言') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
}

describe('MentionInput', () => {
  it('输入 @ 后弹出补全列表；无匹配则不弹', () => {
    render(<MentionInput value="" onChange={() => {}} onEnter={() => {}} agents={agents} placeholder="发言" />);
    type('大家好 @');
    expect(screen.getByText('小豆')).toBeTruthy();
    expect(screen.getByText('老豆')).toBeTruthy();
    type('大家好 @不存在的');
    expect(screen.queryByText('小豆')).toBeNull();
  });

  it('点击候选：@query 替换为 @名字 + 空格，弹层关闭', () => {
    const onChange = vi.fn();
    render(<MentionInput value="大家好 @" onChange={onChange} onEnter={() => {}} agents={agents} placeholder="发言" />);
    fireEvent.click(screen.getByText('小豆'));
    expect(onChange).toHaveBeenCalledWith('大家好 @小豆 ');
  });

  it('弹层开启时 Enter 选中候选项而非触发 onEnter', () => {
    const onEnter = vi.fn();
    const onChange = vi.fn();
    render(<MentionInput value="@" onChange={onChange} onEnter={onEnter} agents={agents} placeholder="发言" />);
    const input = screen.getByPlaceholderText('发言');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnter).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('@小豆 ');
  });

  it('弹层关闭时 Enter 触发 onEnter', () => {
    const onEnter = vi.fn();
    render(<MentionInput value="大家好" onChange={() => {}} onEnter={onEnter} agents={agents} placeholder="发言" />);
    fireEvent.keyDown(screen.getByPlaceholderText('发言'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledOnce();
  });
});
