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
    fireEvent.change(screen.getByPlaceholderText(/输入 ADMIN_TOKEN/), { target: { value: 'right-token' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => expect(screen.getByText('在线 Agent')).toBeTruthy()); // 概览中文标签
    expect(sessionStorage.getItem('ai-smash-admin')).toBe('right-token');
  });

  it('events tab：服务端 camelCase 行正常渲染（latency 显示）', async () => {
    sessionStorage.setItem('ai-smash-admin', 'tok');
    vi.stubGlobal('fetch', stubApi({
      '/api/admin/overview': { keys: 1, agentsOnline: 0, activeRooms: 1, messages10m: 0, agentConnections: 0, humanConnections: 0 },
      '/api/admin/events?limit=50': { rows: [{ id: 'ev_1', roomId: 'lobby', agentId: 'ag_1', status: 'posted', reason: null, latencyMs: 800 }] },
    }));
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('派发事件'));
    await waitFor(() => expect(screen.getByText('ev_1')).toBeTruthy());
    expect(screen.getByText('lobby')).toBeTruthy();
    expect(screen.getByText('800ms')).toBeTruthy(); // latencyMs（snake_case 读取会渲染空白）
  });

  it('rooms tab：展示代建表单，创建成功提示房间 id；lobby 行无删除按钮', async () => {
    sessionStorage.setItem('ai-smash-admin', 'tok');
    const f = vi.fn(async (url: string, init?: any) => {
      if (url === '/api/admin/overview') {
        return new Response(JSON.stringify({ keys: 1, agentsOnline: 0, activeRooms: 1, messages10m: 0, agentConnections: 0, humanConnections: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/admin/rooms' && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ rows: [{ id: 'lobby', title: '大厅', status: 'active' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/admin/rooms' && init?.method === 'POST') {
        expect(JSON.parse(init.body)).toEqual({ title: '巡演上海站', visibility: 'private' });
        return new Response(JSON.stringify({ id: 'rm_new', inviteCode: 'ABC123' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', f);
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('房间')); // tab 中文化
    await waitFor(() => expect(screen.getByText('大厅')).toBeTruthy());
    expect(screen.getByText('lobby')).toBeTruthy(); // 房间 id 以弱化样式同行展示
    expect(screen.queryByText('删除')).toBeNull(); // lobby 行不给删除入口
    fireEvent.change(screen.getByPlaceholderText('新房间名'), { target: { value: '巡演上海站' } });
    fireEvent.click(screen.getByText('私有'));
    fireEvent.click(screen.getByText('创建房间'));
    await waitFor(() => expect(screen.getByText(/已创建 rm_new · 邀请码 ABC123/)).toBeTruthy());
  });

  it('agents tab：只有在线 agent 显示断开按钮，离线显示占位', async () => {
    sessionStorage.setItem('ai-smash-admin', 'tok');
    vi.stubGlobal('fetch', stubApi({
      '/api/admin/overview': { keys: 1, agentsOnline: 0, activeRooms: 1, messages10m: 0, agentConnections: 0, humanConnections: 0 },
      '/api/admin/agents': { rows: [
        { id: 'ag_on', keyId: 'key_1', name: '在线豆', status: 'online', score: null },
        { id: 'ag_off', keyId: 'key_1', name: '离线豆', status: 'offline', score: null },
      ] },
    }));
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('Agent'));
    await waitFor(() => expect(screen.getByText('在线豆')).toBeTruthy());
    const onRow = screen.getByText('在线豆').closest('tr')!;
    expect(onRow.textContent).toContain('断开');
    const offRow = screen.getByText('离线豆').closest('tr')!;
    expect(offRow.textContent).not.toContain('断开'); // 离线无连接可断，不渲染按钮
  });

  it('messages tab：默认全部房间，选房间后按 roomId 检索；已删行显式标注', async () => {
    sessionStorage.setItem('ai-smash-admin', 'tok');
    const f = vi.fn(async (url: string) => {
      if (url === '/api/admin/overview') {
        return new Response(JSON.stringify({ keys: 1, agentsOnline: 0, activeRooms: 2, messages10m: 0, agentConnections: 0, humanConnections: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/admin/rooms') {
        return new Response(JSON.stringify({ rows: [{ id: 'lobby', title: '大厅', status: 'active' }, { id: 'rm_2', title: '深夜哲学', status: 'active' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/admin/messages?limit=100') {
        return new Response(JSON.stringify({ rows: [
          { id: 'm_a', roomId: 'rm_2', seq: 1, senderName: '阿伟', text: '别房的话', deletedAt: null },
          { id: 'm_dead', roomId: 'lobby', seq: 2, senderName: '小豆', text: '被删的话', deletedAt: '2026-10-29T00:00:00Z' },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/admin/messages?roomId=rm_2&limit=100') {
        return new Response(JSON.stringify({ rows: [{ id: 'm_a', roomId: 'rm_2', seq: 1, senderName: '阿伟', text: '别房的话', deletedAt: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', f);
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('消息'));
    await waitFor(() => expect(screen.getByText(/别房的话/)).toBeTruthy()); // 默认=全部房间，跨房可见
    expect(screen.getByText(/原文已从直播间隐藏/)).toBeTruthy();
    expect(screen.getByText(/原文已从直播间隐藏/).closest('tr')!.textContent).not.toContain('软删');
    // 切到单房间 → 请求带 roomId
    fireEvent.change(screen.getByLabelText('筛选房间'), { target: { value: 'rm_2' } });
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === '/api/admin/messages?roomId=rm_2&limit=100')).toBe(true));
    await waitFor(() => expect(screen.queryByText(/被删的话/)).toBeNull()); // 只剩 rm_2 的消息
  });
});
