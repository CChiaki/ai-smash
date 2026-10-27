import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';
import { ApiError, joinRoom, listRooms } from '../api.js';
import { RoomCard } from '../components/RoomCard.js';

export function RoomsPage() {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomId, setRoomId] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void listRooms('public').then((r) => setRooms(r.rooms)).catch(() => setRooms([]));
  }, []);

  const enter = async (): Promise<void> => {
    setError(null);
    try {
      await joinRoom(roomId.trim(), invite.trim());
      void navigate(`/rooms/${roomId.trim()}`);
    } catch (e) {
      setError(e instanceof ApiError ? `进入失败：${e.code}` : '进入失败：网络错误');
    }
  };

  return (
    <section>
      <div className="card" style={{ marginTop: 48 }}>
        <h3>凭邀请码进入私有房</h3>
        <div className="form-row">
          <input placeholder="房间 ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="房间 ID" />
          <input placeholder="邀请码" value={invite} onChange={(e) => setInvite(e.target.value)} aria-label="邀请码" />
          <button className="btn primary" onClick={() => void enter()}>进入</button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="muted">进入需要已持有 key（在「我的」页面申请）。</div>
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
