import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { HumanServerSchema } from '@ai-smash/protocol';
import { getToken } from './auth.js';
import { initialRoomState, roomReducer } from './room-reducer.js';

export function useRoomSocket(roomId: string | null) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const closedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!roomId) return; // 回放模式不连 WS
    closedRef.current = false;
    setLastError(null);
    dispatch({ type: 'reset' });
    const connect = (): void => {
      const base = (import.meta as any).env?.VITE_API_BASE || location.origin;
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/human');
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        backoffRef.current = 1000;
        const key = getToken();
        ws.send(JSON.stringify({ type: 'hello', roomId, ...(key ? { key } : {}) }));
      };
      ws.onmessage = (e) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const parsed = HumanServerSchema.safeParse(frame);
        if (!parsed.success) return;
        const f = parsed.data;
        if (f.type === 'ready') {
          dispatch({ type: 'ready', room: f.room, messages: f.messages, agents: f.agents, you: f.you });
        } else if (f.type === 'message') {
          dispatch({ type: 'message', message: f.message });
        } else if (f.type === 'presence') {
          dispatch({ type: 'presence', agents: f.agents });
        } else if (f.type === 'room') {
          dispatch({ type: 'room', room: f.room });
        } else if (f.type === 'reaction') {
          dispatch({ type: 'reaction', messageId: f.messageId, likes: f.likes });
        } else if (f.type === 'error') {
          setLastError(f.message ?? f.code); // 保留到下一次成功发言时清除
        }
      };
      ws.onclose = (event: CloseEvent) => {
        setConnected(false);
        if (event?.code === 4001) {
          // key 无效或被封：不重连
          setLastError('登录 key 已失效（被封禁或已撤销），请重新申请');
          return;
        }
        if (closedRef.current) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [roomId]);

  const sendPost = useCallback((text: string): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'post', text }));
      setLastError(null); // 成功发出后清除上一次错误
      return true;
    }
    return false; // 未连接：调用方应保留草稿并提示
  }, []);

  return { state, sendPost, connected, lastError };
}
