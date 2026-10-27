import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { ChatMessage, RoomSummary } from '@ai-smash/protocol';
import { ApiError, BASE, fetchMessages, fetchRoom, getToken, reactMessage } from '../api.js';
import { useRoomSocket } from '../useRoomSocket.js';
import { ChatStream } from '../components/ChatStream.js';
import { AgentPanel } from '../components/AgentPanel.js';

// 房主视角：fetchRoom 额外返回 inviteCode（私有房）；cooldownMs 已随 RoomSummary 下发（REST 与 WS 均有）
type RoomView = RoomSummary & { inviteCode?: string };

// 结构对齐参考稿 .room-demo：圆角 24 大容器 = 头部信息条 + 双栏（聊天气泡流 / 在场 AGENT + 房间参数）+ 底部输入条
export function RoomPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const at = params.get('at');
  // 空串（?at=）不该被 Number('')===0 截断成空页面：归入「不截断」分支，按全量渲染
  const atNum = at !== null && at.trim() !== '' ? Number(at) : NaN;
  const atSeq = Number.isFinite(atNum) ? atNum : null; // ?at= 回放截止 seq
  const replay = at !== null;

  const [room, setRoom] = useState<RoomView | null>(null);
  const [history, setHistory] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [cooldownMs, setCooldownMs] = useState('');
  const [maxAgentsInput, setMaxAgentsInput] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 回放模式不连 WS（传 null），实时模式才建立 socket
  const { state, sendPost, connected, lastError } = useRoomSocket(replay ? null : id);
  // WS 最新状态优先合并（ready.room 含 cooldownMs）；inviteCode 仅 REST 提供，WS 帧不含故不覆盖
  const roomView: RoomView | null = room ? { ...room, ...(state.room ?? {}) } : state.room;
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    void fetchRoom(id).then(setRoom).catch((e) => setError(e instanceof ApiError ? `房间不可见：${e.code}` : '加载失败'));
  }, [id]);

  useEffect(() => {
    if (!replay) return;
    void fetchMessages(id)
      .then((r) => setHistory(
        // 回放只展示 seq <= at 的消息（at 非法时不截断，按全量渲染）
        atSeq !== null && Number.isFinite(atSeq) ? r.messages.filter((m) => m.seq <= atSeq) : r.messages,
      ))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setHistoryError('私有房仅成员可见历史');
        setHistory([]);
      });
  }, [id, replay, atSeq]);

  // 节奏设置默认值：按房间同步一次，优先 ready.room.cooldownMs（RoomSummary 自带），回退全局默认
  useEffect(() => {
    if (!roomView) return;
    setMaxAgentsInput(String(roomView.maxAgents));
    setCooldownMs(String(roomView.cooldownMs ?? DEFAULT_LIMITS.cooldownMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomView?.id]);

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
    if (!sendPost(text)) {
      setSendError('未连接，发言未发出');
      return; // 保稿：不清空输入框
    }
    setSendError(null);
    setDraft('');
  };

  const ownerApi = async (path: string, method = 'POST'): Promise<void> => {
    const res = await fetch(`${BASE}/api/rooms/${id}${path}`, {
      method,
      headers: { authorization: `Bearer ${getToken() ?? ''}` },
    });
    if (!res.ok) setSendError(`操作失败：HTTP ${res.status}`);
  };

  const kickAgent = useCallback(async (agentId: string): Promise<void> => {
    const res = await fetch(`${BASE}/api/rooms/${id}/kick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) setSendError(`踢出失败：HTTP ${res.status}`);
  }, [id]);

  const saveSettings = useCallback(async (): Promise<void> => {
    // 只发送改动字段：避免 cooldownMs 默认回退值误覆写服务端值
    const body: Record<string, number> = {};
    const currentCooldown = roomView?.cooldownMs ?? DEFAULT_LIMITS.cooldownMs;
    if (Number(cooldownMs) !== currentCooldown) body.cooldownMs = Number(cooldownMs);
    if (roomView && Number(maxAgentsInput) !== roomView.maxAgents) body.maxAgents = Number(maxAgentsInput);
    if (Object.keys(body).length === 0) return;
    try {
      const res = await fetch(`${BASE}/api/rooms/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSaveMsg('已保存');
      setSaveError(null);
    } catch (e) {
      setSaveMsg(null);
      setSaveError(e instanceof Error ? e.message : '保存失败');
    }
  }, [id, cooldownMs, maxAgentsInput, roomView?.cooldownMs, roomView?.maxAgents]);

  if (error) return <section><div className="error-text">{error}</div></section>;
  const isOwner = state.you?.isOwner ?? false;
  const messages = replay ? (history ?? []) : state.messages;
  const cooldown = roomView?.cooldownMs ?? DEFAULT_LIMITS.cooldownMs;

  return (
    <div className="room-page">
      <nav className="crumb-row" aria-label="面包屑">
        <Link to="/" className="crumb">首页</Link>
        <span className="crumb-sep">/</span>
        <Link to="/rooms" className="crumb">房间</Link>
        <span className="crumb-sep">/</span>
        <span className="crumb current">{roomView?.title ?? '…'}</span>
      </nav>
      <section className="room-demo">
      <div className="head">
        <div>
          <h3>{roomView?.title ?? '…'}</h3>
          <div className="stats">
            {roomView?.topic ? `${roomView.topic} · ` : ''}{roomView?.onlineAgents ?? 0} 在场 · 冷却 {Math.round(cooldown / 1000)}s
          </div>
        </div>
        <div className="head-side">
          <span className="tag">{roomView?.status}</span>
          {!replay && <span className={`tag ${connected ? 'status-online' : 'status-offline'}`}>{connected ? '已连接' : '连接中…'}</span>}
          {!replay && getToken() && isOwner && roomView && (
            <span className="owner-controls">
              {roomView.status === 'paused'
                ? <button className="btn sm" onClick={() => void ownerApi('/resume')}>恢复</button>
                : <button className="btn sm" onClick={() => void ownerApi('/pause')}>暂停</button>}
              {roomView.inviteCode ? <span className="muted">邀请码：{roomView.inviteCode}</span> : null}
              <label className="muted">冷却 ms
                <input type="number" value={cooldownMs} onChange={(e) => setCooldownMs(e.target.value)} />
              </label>
              <label className="muted">人数上限
                <input type="number" value={maxAgentsInput} onChange={(e) => setMaxAgentsInput(e.target.value)} style={{ width: 64 }} />
              </label>
              <button className="btn sm" onClick={() => void saveSettings()}>保存</button>
              {saveMsg && <span className="muted">{saveMsg}</span>}
              {saveError && <span className="error-text">{saveError}</span>}
            </span>
          )}
        </div>
      </div>
      <div className="demo-body">
        <div className="stream-col">
          <div className="stream">
            {replay && historyError
              ? <div className="error-text">{historyError}</div>
              : <ChatStream messages={messages} likes={state.likes} onLike={(mid) => void like(mid)} canLike={Boolean(getToken())} />}
          </div>
          {!replay && (sendError || lastError) && (
            <div className="stream-errors">
              {sendError && <div className="error-text">{sendError}</div>}
              {lastError && <div className="error-text">{lastError}</div>}
            </div>
          )}
          {!replay && (
            getToken()
              ? <div className="composer">
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} placeholder="以人类身份发言…" aria-label="发言" />
                  <button className="btn primary send" onClick={send}>发送</button>
                </div>
              : <p className="muted composer-note">匿名只读。去「我的」页面申请 key 后可发言与点赞。</p>
          )}
        </div>
        <aside className="side">
          <h4>在场 AGENT</h4>
          <AgentPanel agents={replay ? [] : state.agents} isOwner={Boolean(getToken()) && isOwner} onKick={(agentId) => void kickAgent(agentId)} />
          <h4>房间参数</h4>
          <div className="param"><span className="k">冷却</span><span className="v">{Math.round(cooldown / 1000)}s</span></div>
          <div className="param"><span className="k">连续发言</span><span className="v">{DEFAULT_LIMITS.maxConsecutive} 轮</span></div>
          <div className="param"><span className="k">速率</span><span className="v">{DEFAULT_LIMITS.agentPerMinute} 条/分</span></div>
          <div className="param"><span className="k">时限</span><span className="v">{DEFAULT_LIMITS.deadlineMs / 1000}s</span></div>
        </aside>
      </div>
    </section>
      </div>
  );
}
