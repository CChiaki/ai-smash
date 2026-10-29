import type { ChatMessage } from '@ai-smash/protocol';

// 头像色按发送者名字 hash 稳定取三组渐变（av-1/av-2/av-3，色值出自 12 色板）
function avatarClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `av-${(h % 3) + 1}`;
}

// 按 base64 魔数猜图片扩展名；仅识别位图四类（png/jpeg/gif/webp），SVG 等其余一律落到
// png——数据解码后与 png 魔数不符，浏览器拒绝渲染，从而拦截内联 SVG 注入
function imgExtFromBase64(b64: string): string {
  const s = b64.replace(/\s/g, '');
  if (s.startsWith('iVBORw0KGgo')) return 'png';
  if (s.startsWith('/9j/')) return 'jpeg';
  if (s.startsWith('R0lGOD')) return 'gif';
  if (s.startsWith('UklGR')) return 'webp';
  return 'png';
}

// 消息时间：今天只显示 HH:MM，跨天补月/日（Invalid date 防御返回空串）
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// 形态对齐参考稿 .bubble：渐变头像(34px/11) + who + 正文 + ♡赞
export function ChatStream({ messages, likes, onLike, canLike, streaming }: {
  messages: ChatMessage[];
  likes: Record<string, number>;
  onLike?: (messageId: string) => void;
  canLike?: boolean;
  streaming?: Record<string, { name: string; text: string }>;
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
                  {m.sender.name}
                  {m.sender.kind === 'human' && <span className="who-tag"> · 人类</span>}
                  {/* · 分隔符进文本节点：复制出的纯文本也有名字/时间边界，避免 4.1+19:16 黏成 4.119:16 */}
                  {fmtTime(m.createdAt) && <span className="msg-time">· {fmtTime(m.createdAt)}</span>}
                </span>
                <span className="msg-text">
                  {m.sender.kind === 'human'
                    ? m.text.split(/(?<![\w@])(@[^\s@]{1,32})/g).map((part, i) => // 高亮边界与引擎 resolveMentions 一致（@ 前不得为 ASCII 字母数字或 @）
                        part.startsWith('@') ? <span key={i} className="mention">{part}</span> : part)
                    : m.text}
                  {m.attachments?.map((a, i) => a.kind === 'image' ? (
                    a.base64
                      ? <img key={i} src={`data:image/${imgExtFromBase64(a.base64)};base64,${a.base64}`} alt="附件图片" loading="lazy" className="msg-attachment" />
                      : <img key={i} src={a.url} alt="附件图片" loading="lazy" referrerPolicy="no-referrer" className="msg-attachment" />
                  ) : a.kind === 'audio' ? (
                    <audio key={i} controls src={a.url} className="msg-attachment" />
                  ) : a.kind === 'video' ? (
                    <video key={i} controls src={a.url} className="msg-attachment" />
                  ) : null)}
                  {m.sender.kind === 'agent' && canLike && onLike && (
                    <button className="like-btn" title="点赞" onClick={() => onLike(m.id)}>♡ <span>{likes[m.id] ?? m.likes ?? 0}</span></button>
                  )}
                </span>
              </div>
            </div>
          )
      ))}
      {Object.entries(streaming ?? {}).map(([agentId, s]) => (
        s.text.length > 0 && (
          <div key={`streaming-${agentId}`} className={`chat-msg chat-agent streaming`}>
            <span className={`avatar ${avatarClass(s.name)}`}>{s.name.slice(0, 1)}</span>
            <div className="msg-body">
              <span className="msg-who">{s.name}</span>
              <span className="msg-text">{s.text}<span className="cursor">▍</span></span>
            </div>
          </div>
        )
      ))}
      {messages.length === 0 && Object.keys(streaming ?? {}).length === 0 && <div className="muted">还没有消息，等待有人投喂…</div>}
    </div>
  );
}
