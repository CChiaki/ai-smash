// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: any[] = [];
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
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
  room: { id: 'lobby', title: '大厅', topic: null, visibility: 'public', status: 'active', onlineAgents: 0, maxAgents: 50, cooldownMs: 10000 },
  messages: [],
  agents: [],
  you: { keyId: 'k_1', name: '阿伟', isOwner: true },
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
    expect(result.current.state.you?.isOwner).toBe(true); // ready you 帧进入 state
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

  it('未连接时 sendPost 返回 false；error 帧写入 lastError，成功发送后清除', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws = FakeWebSocket.instances.at(-1)!;
    expect(result.current.connected).toBe(false);
    expect(result.current.sendPost('大家好')).toBe(false); // 未连接不发送
    expect(ws.sent).toHaveLength(0);
    act(() => ws.open());
    act(() => ws.receive({ type: 'error', code: 'rate_limited', message: '发言太频繁，稍后再试' }));
    expect(result.current.lastError).toBe('发言太频繁，稍后再试');
    // 已收录 code 映射为人类可读提示（400/429 拒收有明确反馈，不再表现为「话凭空消失」）
    act(() => ws.receive({ type: 'error', code: 'invalid', message: '发言内容不合法：需为 1~4000 字' }));
    expect(result.current.lastError).toBe('发言内容不合法：需为 1~4000 字');
    act(() => ws.receive({ type: 'error', code: 'throttled', message: 'throttled' }));
    expect(result.current.lastError).toBe('发言太快，稍等片刻再试');
    act(() => result.current.sendPost('再试一次'));
    expect(result.current.lastError).toBeNull(); // 成功发送后清除
    expect(ws.sent.at(-1)).toMatchObject({ type: 'post', text: '再试一次' });
  });

  it('卸载后清掉待触发的重连定时器（不再幽灵重连）', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { unmount } = renderHook(() => useRoomSocket('lobby'));
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.open());
    act(() => ws.close()); // onclose 调度 1000ms 后重连
    expect(FakeWebSocket.instances.length).toBe(1);
    unmount(); // cleanup 应 clearTimeout
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances.length).toBe(1); // 未新建连接
  });

  it('close code 4001（key 被封/失效）：不重连且提示重新申请', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const { useRoomSocket } = await import('../src/useRoomSocket.js');
    const { result } = renderHook(() => useRoomSocket('lobby'));
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.open());
    act(() => ws.close(4001)); // 服务端以 4001 关闭：key 无效或被封
    expect(result.current.lastError).toContain('失效');
    expect(result.current.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000); // 足够跨过整个退避上限
    expect(FakeWebSocket.instances.length).toBe(1); // 未安排任何重连
  });
});
