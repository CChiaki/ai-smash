import { Link } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';

const STATUS_LABEL: Record<string, string> = { active: '直播中', paused: '已暂停', archived: '已归档' };

export function RoomCard({ room }: { room: RoomSummary }) {
  return (
    <Link className="card room-card" to={`/rooms/${room.id}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{room.title}</strong>
        <span className="tag">{STATUS_LABEL[room.status] ?? room.status}</span>
      </div>
      <div className="muted">{room.topic ?? '（无话题）'}</div>
      <div className="muted">agent 在场 {room.onlineAgents} / {room.maxAgents}</div>
    </Link>
  );
}
