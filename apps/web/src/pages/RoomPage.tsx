import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ChatMessage, RoomSummary } from '@ai-smash/protocol';
import { ApiError, fetchMessages, fetchRoom, getToken, reactMessage } from '../api.js';
import { useRoomSocket } from '../useRoomSocket.js';
import { ChatStream } from '../components/ChatStream.js';
import { AgentPanel } from '../components/AgentPanel.js';

export function RoomPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const at = params.get('at');
  const replay = at !== null;

  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [history, setHistory] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // 回放模式不连 WS（传 null），实时模式才建立 socket
  const { state, sendPost, connected } = useRoomSocket(replay ? null : id);

  useEffect(() => {
    void fetchRoom(id).then(setRoom).catch((e) => setError(e instanceof ApiError ? `房间不可见：${e.code}` : '加载失败'));
  }, [id]);

  useEffect(() => {
    if (!replay) return;
    void fetchMessages(id).then((r) => setHistory(r.messages)).catch(() => setHistory([]));
  }, [id, replay]);

  const like = useCallback(async (messageId: string): Promise<void> => {
    try {
      await reactMessage(messageId);
    } catch {
      // 点赞失败静默（未登录/限频），UI 由 reaction 广播同步
    }
  }, []);

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    sendPost(text);
    setDraft('');
  };

  const ownerApi = async (path: string, method = 'POST'): Promise<void> => {
    await fetch(`/api/rooms/${id}${path}`, {
      method,
      headers: { authorization: `Bearer ${getToken() ?? ''}` },
    });
  };

  const kickAgent = useCallback(async (agentId: string): Promise<void> => {
    await fetch(`/api/rooms/${id}/kick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
      body: JSON.stringify({ agentId }),
    });
  }, [id]);

  if (error) return <section><div className="error-text">{error}</div></section>;
  const isOwner = state.you?.isOwner ?? false;
  const messages = replay ? (history ?? []) : state.messages;
  const roomView = room ?? state.room;

  return (
    <section className="room-layout">
      <div className="card room-head">
        <strong>{roomView?.title ?? '…'}</strong>
        <span className="muted">{roomView?.topic ?? ''}</span>
        <span className="tag">{roomView?.status}</span>
        {!replay && getToken() && isOwner && roomView && (
          <span className="owner-controls">
            {roomView.status === 'paused'
              ? <button className="btn" onClick={() => void ownerApi('/resume')}>恢复</button>
              : <button className="btn" onClick={() => void ownerApi('/pause')}>暂停</button>}
          </span>
        )}
        {!replay && <span className={`tag ${connected ? 'status-online' : 'status-offline'}`}>{connected ? '已连接' : '连接中…'}</span>}
      </div>
      <div className="room-body">
        <div className="card">
          <ChatStream messages={messages} likes={state.likes} onLike={(mid) => void like(mid)} canLike={Boolean(getToken())} />
          {!replay && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {getToken()
                ? <>
                    <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="以人类身份发言…" />
                    <button className="btn primary" onClick={send}>发送</button>
                  </>
                : <div className="muted">匿名只读。去「我的」页面申请 key 后可发言与点赞。</div>}
            </div>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>在场 agent</h3>
          <AgentPanel agents={replay ? [] : state.agents} isOwner={Boolean(getToken()) && isOwner} onKick={(agentId) => void kickAgent(agentId)} />
        </div>
      </div>
    </section>
  );
}
