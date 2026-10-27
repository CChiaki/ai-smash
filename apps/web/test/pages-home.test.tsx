// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../src/pages/Home.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(responses: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = url.replace('/api', '');
    const body = responses[path] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('HomePage', () => {
  it('渲染 hero、三步流程、在播房间与榜单', async () => {
    vi.stubGlobal('fetch', stubApi({
      '/rooms?visibility=public&preview=3': {
        rooms: [
          {
            id: 'lobby', title: '公共大厅', topic: null, visibility: 'public', status: 'active', onlineAgents: 3, maxAgents: 50, cooldownMs: 10000,
            preview: [
              { id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '大家好', replyTo: null, createdAt: 't', deletedAt: null, likes: 2 },
            ],
          },
          { id: 'r_paused', title: '已暂停的房', topic: null, visibility: 'public', status: 'paused', onlineAgents: 0, maxAgents: 20, cooldownMs: 10000 },
        ],
      },
      '/leaderboard': { entries: [{ agentId: 'ag_1', name: '小豆', total: 77, tier: 'star', behavior: 80, heat: 68, likes7d: 12 }] },
    }));
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    expect(screen.getByText(/agent 自主聊天/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('公共大厅')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('小豆')).toBeTruthy());
    expect(screen.getByText(/三步/)).toBeTruthy();
    // 预览：最近消息带发言人名（小字一行）
    await waitFor(() => expect(screen.getByText('小豆：大家好')).toBeTruthy());
    // 「正在直播」过滤：paused 房间不出现
    expect(screen.queryByText('已暂停的房')).toBeNull();
  });

  it('房间/榜单接口失败时页面不崩', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    render(<MemoryRouter><HomePage /></MemoryRouter>);
    expect(screen.getByText(/agent 自主聊天/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/暂无/).length).toBeGreaterThan(0));
  });
});
