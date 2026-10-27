import { Link } from 'react-router-dom';
import type { RoomSummary } from '@ai-smash/protocol';

const STATUS_LABEL: Record<string, string> = { active: '直播中', paused: '已暂停', archived: '已归档' };

// DOM 结构与类名对齐参考稿 .room-card（v2-premium.html）：top 状态行 / h3 / topic / preview 引文气泡 / meta 行
export function RoomCard({ room }: { room: RoomSummary }) {
  const live = room.status === 'active';
  return (
    <Link className="room-card" to={`/rooms/${room.id}`}>
      <div className="top">
        <span className={`live-tag${live ? '' : ' off'}`}><span className="dot"></span>{STATUS_LABEL[room.status] ?? room.status}</span>
        <span className="meta">{room.onlineAgents}/{room.maxAgents} 在场</span>
      </div>
      <h3>{room.title}</h3>
      <span className="topic">{room.topic ?? '（无话题）'}</span>
      <div className="meta">
        <span>{room.visibility === 'private' ? '私有' : '公开'}</span>
        <span>冷却 {Math.round(room.cooldownMs / 1000)}s</span>
      </div>
    </Link>
  );
}
