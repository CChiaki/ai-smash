// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MePage } from '../src/pages/MePage.js';
import { AdminPage } from '../src/pages/AdminPage.js';

afterEach(() => {
  cleanup(); // vitest globals:false，RTL 自动清理不生效，需手动
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  window.confirm = confirmOrig; // 恢复被测试覆写的 window.confirm
});

const confirmOrig = window.confirm;

function stubApi(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (url: string) => {
    const body = routes[url] ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

describe('MePage', () => {
  it('匿名：创建 key 后明文只展示一次，并立即加载 key 信息', async () => {
    const f = stubApi({
      '/api/keys': { key: 'sk_one_time', id: 'key_1', label: null },
      '/api/me': { key: { id: 'key_1', label: null, createdAt: 't' }, agents: [] },
    }, 201);
    vi.stubGlobal('fetch', f);
    render(<MemoryRouter><MePage /></MemoryRouter>);
    fireEvent.click(screen.getByText('申请 key'));
    await waitFor(() => expect(screen.getByText('sk_one_time')).toBeTruthy());
    expect(localStorage.getItem('ai-smash-key')).toBe('sk_one_time');
    expect(screen.queryByText(/key id（排查用的标识，不是密钥）：key_1/)).toBeNull(); // 明文展示期隐藏遮蔽态与元信息
    expect(screen.queryByText('已保存在本机')).toBeNull();
  });

  it('已登录：显示 agent 列表与撤销', async () => {
    localStorage.setItem('ai-smash-key', 'sk_tok');
    vi.stubGlobal('fetch', stubApi({
      '/api/me': { key: { id: 'key_1', label: '阿伟', createdAt: 't' }, agents: [{ id: 'ag_1', keyId: 'key_1', name: '小豆', status: 'online', lastSeenAt: null, createdAt: 't' }] },
      '/api/keys/current': {},
    }));
    window.confirm = () => true;
    render(<MemoryRouter><MePage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('小豆')).toBeTruthy());
    expect(screen.getByText(/key id（排查用的标识，不是密钥）：key_1/)).toBeTruthy(); // 无 freshKey 时显示遮蔽态与元信息
    fireEvent.click(screen.getByText('撤销 key'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/keys/current' && (c[1] as any)?.method === 'DELETE')).toBe(true));
  });
});

describe('AdminPage', () => {
  it('无 token：输入错误 token 显示错误；正确 token 进入概览', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/admin/overview') {
        return new Response(JSON.stringify({ keys: 1, agentsOnline: 2, activeRooms: 1, messages10m: 5, agentConnections: 2, humanConnections: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'invalid_admin_token' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/ADMIN_TOKEN/), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByText(/token 无效/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/ADMIN_TOKEN/), { target: { value: 'right-token' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByText('agentsOnline')).toBeTruthy());
    expect(sessionStorage.getItem('ai-smash-admin')).toBe('right-token');
  });

  it('events tab：服务端 camelCase 行正常渲染（latency 显示）', async () => {
    sessionStorage.setItem('ai-smash-admin', 'tok');
    vi.stubGlobal('fetch', stubApi({
      '/api/admin/overview': { keys: 1, agentsOnline: 0, activeRooms: 1, messages10m: 0, agentConnections: 0, humanConnections: 0 },
      '/api/admin/events?limit=50': { rows: [{ id: 'ev_1', roomId: 'lobby', agentId: 'ag_1', status: 'posted', reason: null, latencyMs: 800 }] },
    }));
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('events'));
    await waitFor(() => expect(screen.getByText('ev_1')).toBeTruthy());
    expect(screen.getByText('lobby')).toBeTruthy();
    expect(screen.getByText('800')).toBeTruthy(); // latencyMs（snake_case 读取会渲染空白）
  });
});
