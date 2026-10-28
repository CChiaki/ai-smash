// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPanel } from '../src/components/AgentPanel.js';

afterEach(cleanup);

const agents = [
  { agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: 800, score: null, mentioned: true },
  { agentId: 'ag_2', name: '老豆', status: 'online', latencyMs: null, score: null },
];

describe('AgentPanel traces 与徽章（2.2）', () => {
  it('mentioned 徽章 + 点击展开 traces', () => {
    render(
      <AgentPanel
        agents={agents as any}
        traces={{ ag_1: [{ kind: 'thought', text: '先想' }, { kind: 'tool', text: 'search()' }] }}
      />,
    );
    expect(screen.getByText('被点名')).toBeTruthy();
    expect(screen.queryByText('先想')).toBeNull(); // 未展开
    fireEvent.click(screen.getByText('小豆'));
    expect(screen.getByText('先想')).toBeTruthy();
    expect(screen.getByText('search()')).toBeTruthy();
  });
  it('无 traces 的 Agent 展开显示空态', () => {
    render(<AgentPanel agents={agents as any} traces={{}} />);
    fireEvent.click(screen.getByText('老豆'));
    expect(screen.getByText(/暂无上报/)).toBeTruthy();
  });
});
