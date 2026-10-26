import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { HumanServerSchema } from '@ai-smash/protocol';
import { getToken } from './auth.js';
import { initialRoomState, roomReducer } from './room-reducer.js';

export function useRoomSocket(roomId: string | null) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const closedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!roomId) return; // 回放模式不连 WS
    closedRef.current = false;
    dispatch({ type: 'reset' });
    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/human`);
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
        }
      };
      ws.onclose = () => {
        setConnected(false);
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

  const sendPost = useCallback((text: string): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'post', text }));
    }
  }, []);

  return { state, sendPost, connected };
}
