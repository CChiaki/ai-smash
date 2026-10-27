// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatStream } from '../src/components/ChatStream.js';
import { AgentPanel } from '../src/components/AgentPanel.js';
import { RoomPage } from '../src/pages/RoomPage.js';

afterEach(() => {
  cleanup(); // vitest globals:false，RTL 自动清理不生效，需手动
  vi.unstubAllGlobals();
  localStorage.clear();
});

const humanMsg = { id: 'm_1', roomId: 'r', seq: 1, sender: { kind: 'human', name: '阿伟' }, text: '人话', replyTo: null, createdAt: 't', deletedAt: null };
const agentMsg = { id: 'm_2', roomId: 'r', seq: 2, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '-agent', replyTo: null, createdAt: 't', deletedAt: null };
const laterMsg = { id: 'm_3', roomId: 'r', seq: 3, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: '-后来的消息', replyTo: null, createdAt: 't', deletedAt: null };

describe('ChatStream / AgentPanel', () => {
  it('agent 消息显示赞按钮与赞数；点击回调', () => {
    const onLike = vi.fn();
    render(<ChatStream messages={[humanMsg, agentMsg] as any} likes={{ m_2: 3 }} onLike={onLike} canLike />);
    fireEvent.click(screen.getByTitle('点赞'));
    expect(onLike).toHaveBeenCalledWith('m_2');
    expect(screen.getByText('3')).toBeTruthy();
  });
  it('无实时赞数时回退显示消息自带的历史赞数 m.likes', () => {
    render(<ChatStream messages={[{ ...agentMsg, likes: 2 }] as any} likes={{}} onLike={() => {}} canLike />);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('AgentPanel 显示状态与房主踢出按钮', () => {
    const onKick = vi.fn();
    const agents = [{ agentId: 'ag_1', name: '小豆', status: 'thinking', latencyMs: 800, score: { total: 66, tier: 'star' } }];
    render(<AgentPanel agents={agents as any} isOwner onKick={onKick} />);
    expect(screen.getByText('小豆')).toBeTruthy();
    expect(screen.getByText('输入中')).toBeTruthy();
    fireEvent.click(screen.getByText('踢出'));
    expect(onKick).toHaveBeenCalledWith('ag_1');
  });
});

class RoomFakeWS {
  static OPEN = 1;
  static instances: RoomFakeWS[] = [];
  readyState = 0; onopen: any = null; onclose: any = null; onmessage: any = null; sent: any[] = [];
  constructor(_u: string) { RoomFakeWS.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(d: string) { this.sent.push(d); }
  receive(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
}

const ownerReadyFrame = {
  type: 'ready',
  room: { id: 'r1', title: '测试房', topic: null, visibility: 'public', status: 'active', onlineAgents: 1, maxAgents: 20, cooldownMs: 10000 },
  messages: [],
  agents: [],
  you: { keyId: 'k1', name: '房主', isOwner: true },
};

describe('RoomPage', () => {
  function stubRest() {
    return vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms/r1') {
        return new Response(JSON.stringify({ id: 'r1', title: '测试房', topic: null, visibility: 'public', status: 'active', onlineAgents: 1, maxAgents: 20, cooldownMs: 10000 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ messages: [humanMsg, agentMsg] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/rooms/r1/pause') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
  }

  it('回放模式（?at=2）：渲染历史不连 WS', async () => {
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1?at=2']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText('测试房').length).toBeGreaterThan(0));
    expect(screen.getByText('-agent')).toBeTruthy();
  });

  it('回放模式（?at=2）：seq 大于 at 的消息不渲染', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/rooms/r1') {
        return new Response(JSON.stringify({ id: 'r1', title: '测试房', topic: null, visibility: 'public', status: 'active', onlineAgents: 1, maxAgents: 20, cooldownMs: 10000 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ messages: [humanMsg, agentMsg, laterMsg] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    render(
      <MemoryRouter initialEntries={['/rooms/r1?at=2']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('-agent')).toBeTruthy()); // seq=2 保留
    expect(screen.queryByText('-后来的消息')).toBeNull(); // seq=3 > at=2 截断
  });

  it('实时模式：房主可见控制条且暂停按钮生效', async () => {
    // stub WebSocket 防真实连接
    class FakeWS {
      static OPEN = 1;
      static instances: FakeWS[] = [];
      readyState = 0; onopen: any = null; onclose: any = null; onmessage: any = null; sent: any[] = [];
      constructor(_u: string) { FakeWS.instances.push(this); }
      open() { this.readyState = 1; this.onopen?.(); }
      close() { this.readyState = 3; this.onclose?.(); }
      send(d: string) { this.sent.push(d); }
      receive(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
    }
    vi.stubGlobal('WebSocket', FakeWS as any);
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    const ws = (FakeWS as any).instances?.at?.(-1);
    // you.isOwner 由 WS ready you 帧驱动（brief 备注修正：FakeWS 无自动连接，这里手动 open + 注入 ready 帧）
    act(() => {
      ws.open();
      ws.receive({
        type: 'ready',
        room: { id: 'r1', title: '测试房', topic: null, visibility: 'public', status: 'active', onlineAgents: 1, maxAgents: 20, cooldownMs: 10000 },
        messages: [],
        agents: [],
        you: { keyId: 'k1', name: '房主', isOwner: true },
      });
    });
    await waitFor(() => expect(screen.getAllByText('测试房').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('暂停')).toBeTruthy()); // you.isOwner 由 WS ready you 帧驱动
    fireEvent.click(screen.getByText('暂停'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === '/api/rooms/r1/pause')).toBe(true));
  });

  it('私有房房主：控制条显示邀请码与节奏设置，保存发送 PATCH', async () => {
    // stub WebSocket 防真实连接
    class FakeWS {
      static OPEN = 1;
      static instances: FakeWS[] = [];
      readyState = 0; onopen: any = null; onclose: any = null; onmessage: any = null; sent: any[] = [];
      constructor(_u: string) { FakeWS.instances.push(this); }
      open() { this.readyState = 1; this.onopen?.(); }
      close() { this.readyState = 3; this.onclose?.(); }
      send(d: string) { this.sent.push(d); }
      receive(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
    }
    vi.stubGlobal('WebSocket', FakeWS as any);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms/r1') {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ id: 'r1', cooldownMs: 1500, maxAgents: 30 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ id: 'r1', title: '测试房', topic: null, visibility: 'private', status: 'active', onlineAgents: 1, maxAgents: 20, inviteCode: 'INV-9' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    const ws = (FakeWS as any).instances?.at?.(-1);
    act(() => {
      ws.open();
      ws.receive({
        type: 'ready',
        room: { id: 'r1', title: '测试房', topic: null, visibility: 'private', status: 'active', onlineAgents: 1, maxAgents: 20, cooldownMs: 10000 },
        messages: [],
        agents: [],
        you: { keyId: 'k1', name: '房主', isOwner: true },
      });
    });
    // 邀请码来自 fetchRoom（REST 房主视角）
    await waitFor(() => expect(screen.getByText(/邀请码：INV-9/)).toBeTruthy());
    expect(screen.getByText('保存')).toBeTruthy();
    // cooldownMs 随 RoomSummary 下发，此用例验证缺省回退
    expect((screen.getByLabelText('冷却 ms') as HTMLInputElement).value).toBe('10000');
    expect((screen.getByLabelText('人数上限') as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByLabelText('冷却 ms'), { target: { value: '1500' } });
    fireEvent.change(screen.getByLabelText('人数上限'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find((c) => c[0] === '/api/rooms/r1' && (c[1] as any)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as any).body)).toEqual({ cooldownMs: 1500, maxAgents: 30 });
    });
    await screen.findByText('已保存');
  });

  it('实时模式：WS room 帧优先于 REST 初值（暂停状态切换按钮）', async () => {
    vi.stubGlobal('WebSocket', RoomFakeWS as any);
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    const ws = RoomFakeWS.instances.at(-1)!;
    act(() => {
      ws.open();
      ws.receive(ownerReadyFrame);
    });
    await waitFor(() => expect(screen.getByText('暂停')).toBeTruthy());
    act(() => {
      ws.receive({ type: 'room', room: { ...ownerReadyFrame.room, status: 'paused' } });
    });
    await waitFor(() => expect(screen.getByText('恢复')).toBeTruthy());
    expect(screen.queryByText('暂停')).toBeNull();
  });

  it('节奏设置：未改动不发 PATCH；只改 maxAgents 时 body 仅含 maxAgents', async () => {
    vi.stubGlobal('WebSocket', RoomFakeWS as any);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      if (url === '/api/rooms/r1') {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ id: 'r1', maxAgents: 30 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ id: 'r1', title: '测试房', topic: null, visibility: 'private', status: 'active', onlineAgents: 1, maxAgents: 20, inviteCode: 'INV-9' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    const ws = RoomFakeWS.instances.at(-1)!;
    act(() => {
      ws.open();
      ws.receive(ownerReadyFrame);
    });
    await waitFor(() => expect(screen.getByText('保存')).toBeTruthy());
    const patchCalls = () => vi.mocked(fetch).mock.calls.filter((c) => c[0] === '/api/rooms/r1' && (c[1] as any)?.method === 'PATCH');
    // 未改任何值：直接返回，不发请求
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(patchCalls()).toHaveLength(0));
    // 只改 maxAgents：body 只含 maxAgents（cooldownMs 默认回退值不误覆写）
    fireEvent.change(screen.getByLabelText('人数上限'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse((patchCalls()[0][1] as any).body)).toEqual({ maxAgents: 30 });
  });

  it('未连接时发送：保留草稿并提示', async () => {
    vi.stubGlobal('WebSocket', RoomFakeWS as any);
    vi.stubGlobal('fetch', stubRest());
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('以人类身份发言…')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('以人类身份发言…'), { target: { value: '这句不能丢' } });
    fireEvent.click(screen.getByText('发送'));
    expect(screen.getByText('未连接，发言未发出')).toBeTruthy();
    expect((screen.getByPlaceholderText('以人类身份发言…') as HTMLInputElement).value).toBe('这句不能丢');
  });

  it('回放模式：私有房历史 403 显示不可见提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/rooms/r1') {
        return new Response(JSON.stringify({ id: 'r1', title: '私有房', topic: null, visibility: 'private', status: 'active', onlineAgents: 1, maxAgents: 20 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/rooms/r1/messages')) {
        return new Response(JSON.stringify({ error: 'private_room_history' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    localStorage.setItem('ai-smash-key', 'sk_tok');
    render(
      <MemoryRouter initialEntries={['/rooms/r1?at=2']}>
        <Routes><Route path="/rooms/:id" element={<RoomPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('私有房仅成员可见历史')).toBeTruthy());
    expect(screen.queryByText('还没有消息，等待有人投喂…')).toBeNull();
  });
});
