import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';
import { ApiError, createRoom, getToken, joinRoom, listRooms } from '../api.js';
import { RoomCard } from '../components/RoomCard.js';

export function RoomsPage() {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomId, setRoomId] = useState('');
  const [invite, setInvite] = useState('');
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [creating, setCreating] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void listRooms('public').then((r) => setRooms(r.rooms)).catch(() => setRooms([]));
  }, []);

  const enter = async (): Promise<void> => {
    setJoinError(null);
    try {
      await joinRoom(roomId.trim(), invite.trim());
      void navigate(`/rooms/${roomId.trim()}`);
    } catch (e) {
      setJoinError(e instanceof ApiError ? `进入失败：${e.code}` : '进入失败：网络错误');
    }
  };

  const create = async (): Promise<void> => {
    setCreateError(null);
    if (!getToken()) { setCreateError('创建房间需要 key，请先到「我的」页申请'); return; }
    if (title.trim().length === 0) { setCreateError('先给房间起个名字'); return; }
    setCreating(true);
    try {
      const r = await createRoom({ title: title.trim(), topic: topic.trim() || undefined, visibility });
      void navigate(`/rooms/${r.id}`); // 房主控制条在房间页；私有房邀请码也在那里
    } catch (e) {
      setCreateError(e instanceof ApiError ? `创建失败：${e.code}` : '创建失败：网络错误');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section>
      <div className="card first-card">
        <h3>创建房间</h3>
        <div className="form-row">
          <input placeholder="房间名（如：深夜哲学）" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="房间名" />
          <input placeholder="话题（可选）" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="话题" />
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button type="button" className={`btn ${visibility === 'public' ? 'primary' : 'ghost'}`} onClick={() => setVisibility('public')}>公开</button>
          <button type="button" className={`btn ${visibility === 'private' ? 'primary' : 'ghost'}`} onClick={() => setVisibility('private')}>私有（凭邀请码进入）</button>
          <button className="btn primary" onClick={() => void create()} disabled={creating}>创建</button>
        </div>
        {createError && <div className="error-text">{createError}</div>}
        <div className="muted hint">创建后你就是房主：可暂停/调节奏/踢人；私有房的邀请码显示在房间页右上角。</div>
      </div>

      <div className="card">
        <h3>凭邀请码进入私有房</h3>
        <div className="form-row">
          <input placeholder="房间 ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="房间 ID" />
          <input placeholder="邀请码" value={invite} onChange={(e) => setInvite(e.target.value)} aria-label="邀请码" />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {joinError && <div className="error-text">{joinError}</div>}
        <div className="muted hint">进入需要已持有 key（在「我的」页面申请）。</div>
      </div>

      <div className="sec-head"><h2>公开房间</h2></div>
      {rooms === null
        ? <div role="status" aria-label="加载中"><div className="skeleton lg"></div><div className="skeleton lg"></div><div className="skeleton lg"></div></div>
        : rooms.length === 0
          ? <div className="muted">暂无公开房间</div>
          : <div className="cards">{rooms.map((r) => <RoomCard key={r.id} room={r} />)}</div>}
    </section>
  );
}
