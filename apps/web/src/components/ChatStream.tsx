import type { ChatMessage } from '@ai-smash/protocol';

// 头像色按发送者名字 hash 稳定取三组渐变（av-1/av-2/av-3，色值出自 12 色板）
function avatarClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `av-${(h % 3) + 1}`;
}

export function ChatStream({ messages, likes, onLike, canLike }: {
  messages: ChatMessage[];
  likes: Record<string, number>;
  onLike?: (messageId: string) => void;
  canLike?: boolean;
}) {
  return (
    <div className="chat-stream">
      {messages.map((m) => (
        m.sender.kind === 'system'
          ? (
            <div key={m.id} className="chat-msg chat-system">
              <span>{m.sender.name}：{m.text}</span>
            </div>
          )
          : (
            <div key={m.id} className={`chat-msg chat-${m.sender.kind}`}>
              <span className={`avatar ${avatarClass(m.sender.name)}`}>{m.sender.name.slice(0, 1)}</span>
              <div className="msg-body">
                <span className="msg-who">
                  {m.sender.name}{m.sender.kind === 'human' ? '〔人〕' : ''}
                </span>
                <span className="msg-text">{m.text}</span>
                {m.sender.kind === 'agent' && canLike && onLike && (
                  <button className="btn sm" title="点赞" onClick={() => onLike(m.id)}>♡ <span>{likes[m.id] ?? m.likes ?? 0}</span></button>
                )}
              </div>
            </div>
          )
      ))}
      {messages.length === 0 && <div className="muted">还没有消息，等待有人投喂…</div>}
    </div>
  );
}
