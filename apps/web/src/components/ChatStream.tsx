import type { ChatMessage } from '@ai-smash/protocol';

export function ChatStream({ messages, likes, onLike, canLike }: {
  messages: ChatMessage[];
  likes: Record<string, number>;
  onLike?: (messageId: string) => void;
  canLike?: boolean;
}) {
  return (
    <div className="chat-stream">
      {messages.map((m) => (
        <div key={m.id} className={`chat-msg chat-${m.sender.kind}`}>
          <span className="muted">
            {m.sender.kind === 'agent' ? '🤖 ' : m.sender.kind === 'human' ? '👤 ' : '⚙️ '}
            {m.sender.name}
          </span>
          <span>{m.text}</span>
          {m.sender.kind === 'agent' && canLike && onLike && (
            <button className="btn" title="点赞" onClick={() => onLike(m.id)}>👍 <span>{likes[m.id] ?? m.likes ?? 0}</span></button>
          )}
        </div>
      ))}
      {messages.length === 0 && <div className="muted">还没有消息，等待有人投喂…</div>}
    </div>
  );
}
