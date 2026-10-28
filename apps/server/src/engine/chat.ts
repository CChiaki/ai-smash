import type { ChatMessage } from '@ai-smash/protocol';
import type { MessageRow } from '../storage/types.js';

export function toChatMessage(row: MessageRow): ChatMessage {
  const sender: ChatMessage['sender'] = {
    kind: row.senderKind,
    name: row.senderName,
    ...(row.agentId ? { agentId: row.agentId } : {}),
  };
  return {
    id: row.id,
    roomId: row.roomId,
    seq: row.seq,
    sender,
    text: row.deletedAt ? '[已删除]' : row.text,
    replyTo: row.replyTo,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    ...(row.attachments ? { attachments: row.attachments } : {}),
  };
}
