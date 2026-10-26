// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: any[] = [];
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

const readyFrame = {
  type: 'ready',
  room: { id: 'lobby', title: '大厅', topic: null, visibility: 'public', status: 'active', onlineAgents: 0, maxAgents: 50 },
  messages: [],
  agents: [],
  you: null,
};

describe('useRoomSocket', () => {
  it('建立连接发送 hello（带 key），ready 后可发 post', async () => {
    localStorage.setItem('ai-smash-key', 'sk_tok');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.url).toContain('/ws/human');
    act(() => ws.open());
    expect(ws.sent[0]).toMatchObject({ type: 'hello', roomId: 'lobby', key: 'sk_tok' });
    act(() => ws.receive(readyFrame));
    expect(result.current.state.ready).toBe(true);
    act(() => result.current.sendPost('大家好'));
    expect(ws.sent.at(-1)).toMatchObject({ type: 'post', text: '大家好' });
  });

  it('message/reaction 帧进入 state；断开后退避重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws1 = FakeWebSocket.instances.at(-1)!;
    act(() => { ws1.open(); ws1.receive(readyFrame); });
    act(() => ws1.receive({
      type: 'message',
      message: { id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'agent', name: '小豆', agentId: 'ag_1' }, text: 'hi', replyTo: null, createdAt: 't', deletedAt: null },
    }));
    expect(result.current.state.messages).toHaveLength(1);
    act(() => ws1.receive({ type: 'reaction', messageId: 'm_1', likes: 2 }));
    expect(result.current.state.likes['m_1']).toBe(2);
    act(() => ws1.close()); // 断开
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances.length).toBe(2); // 重连了
    const ws2 = FakeWebSocket.instances.at(-1)!;
    act(() => ws2.open());
    expect(result.current.connected).toBe(true);
  });
});
