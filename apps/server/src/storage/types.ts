import type { SenderKind } from '@ai-smash/protocol';

export interface KeyRow {
  id: string; hash: string; label: string | null;
  status: 'active' | 'banned';
  createdAt: string; lastSeenAt: string | null; notes: string | null;
}

export interface AgentRow {
  id: string; keyId: string; name: string;
  status: 'online' | 'thinking' | 'offline' | 'error' | 'waiting';
  lastSeenAt: string | null; createdAt: string;
}

export interface RoomRow {
  id: string; title: string; topic: string | null;
  visibility: 'public' | 'private'; ownerKeyId: string | null;
  status: 'active' | 'paused' | 'archived';
  inviteCode: string | null; cooldownMs: number; maxAgents: number;
  createdAt: string;
}

export interface RoomAgentRow {
  roomId: string; agentId: string;
  status: 'active' | 'kicked' | 'waiting'; joinedAt: string;
}

export interface RoomMemberRow {
  roomId: string; keyId: string; role: 'host' | 'member'; joinedAt: string;
}

export interface MessageRow {
  id: string; roomId: string; seq: number;
  senderKind: SenderKind; senderName: string;
  agentId: string | null; keyId: string | null;
  text: string; replyTo: string | null;
  deletedAt: string | null; createdAt: string;
}

export interface NewMessageInput {
  roomId: string; senderKind: SenderKind; senderName: string;
  agentId: string | null; keyId: string | null;
  text: string; replyTo: string | null; createdAt: string;
}

export interface EventRow {
  id: string; roomId: string; agentId: string; triggerMessageId: string | null;
  status: 'delivered' | 'posted' | 'skipped' | 'timeout' | 'rejected' | 'error';
  reason: string | null; notifiedAt: string; decidedAt: string | null;
  latencyMs: number | null;
}

export interface NewEventInput {
  id: string; roomId: string; agentId: string;
  triggerMessageId: string; notifiedAt: string;
}

export interface StatsPatch {
  delivered?: number; posted?: number; skipped?: number;
  timeout?: number; rejected?: number; throttled?: number; repliesReceived?: number;
}

export interface EventMetrics {
  delivered: number; posted: number; skipped: number; timeout: number;
  rejected: number; throttled: number; latencies: number[];
}

export interface ScoreRow {
  agentId: string; behavior: number; heat: number; total: number;
  tier: string; likes7d: number; computedAt: string;
}

export interface AuditInput {
  action: string; targetType: string; targetId: string;
  detail: string; createdAt: string;
}

export interface AuditRow extends AuditInput { id: string; }

export interface Storage {
  // keys
  createKey(input: { id: string; hash: string; label: string | null; createdAt: string }): KeyRow;
  getKeyByHash(hash: string): KeyRow | undefined;
  getKey(id: string): KeyRow | undefined;
  setKeyStatus(id: string, status: 'active' | 'banned'): void;
  touchKey(id: string, at: string): void;
  listKeys(): KeyRow[];
  // agents
  upsertAgent(input: { id?: string; keyId: string; name: string; at: string }): AgentRow;
  getAgent(id: string): AgentRow | undefined;
  setAgentStatus(id: string, status: AgentRow['status'], at: string): void;
  listAgentsByKey(keyId: string): AgentRow[];
  countAgentsByKey(keyId: string): number;
  listAgents(): AgentRow[];
  // rooms
  ensureLobby(input: { title: string; maxAgents: number; at: string }): RoomRow;
  createRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow;
  getRoom(id: string): RoomRow | undefined;
  getRoomByInviteCode(code: string): RoomRow | undefined;
  listRooms(visibility?: 'public' | 'private'): RoomRow[];
  updateRoom(id: string, patch: Partial<Pick<RoomRow, 'title' | 'topic' | 'status' | 'cooldownMs' | 'maxAgents'>>): RoomRow;
  // room_agents
  addRoomAgent(roomId: string, agentId: string, status: 'active' | 'waiting', at: string): void;
  getRoomAgent(roomId: string, agentId: string): RoomAgentRow | undefined;
  setRoomAgentStatus(roomId: string, agentId: string, status: RoomAgentRow['status']): void;
  removeRoomAgent(roomId: string, agentId: string): void;
  listRoomAgents(roomId: string): RoomAgentRow[];
  listWaitingAgents(roomId: string): RoomAgentRow[];
  listRoomsOfAgent(agentId: string): RoomAgentRow[];
  countRoomAgents(roomId: string, status: RoomAgentRow['status']): number;
  countKeyAgentsInRoom(roomId: string, keyId: string): number;
  // members（人类）
  addMember(roomId: string, keyId: string, role: 'host' | 'member', at: string): void;
  getMember(roomId: string, keyId: string): RoomMemberRow | undefined;
  removeMember(roomId: string, keyId: string): void;
  // messages
  insertMessage(input: NewMessageInput): MessageRow;
  getMessage(id: string): MessageRow | undefined;
  listMessages(roomId: string, opts?: { afterSeq?: number; limit?: number }): MessageRow[]; // 旧→新
  softDeleteMessage(id: string, at: string): void;
  countRepliesTo(agentId: string, sinceIso: string): number;
  // events
  insertEvent(input: NewEventInput): void;
  getEvent(id: string): EventRow | undefined;
  decideEvent(id: string, status: EventRow['status'], reason: string | null, decidedAt: string, latencyMs: number | null): void;
  markAllDeliveredAsTimeout(at: string): number;
  eventMetrics(agentId: string, sinceIso: string): EventMetrics;
  lastPostedLatency(agentId: string): number | null;
  // reactions
  addReaction(messageId: string, keyId: string, at: string): boolean; // false = 重复点赞
  countLikes(messageId: string): number;
  countLikesByAgent(agentId: string, sinceIso: string): number;
  countLikesByKeySince(keyId: string, sinceIso: string): number;
  // stats & scores
  bumpStats(agentId: string, patch: StatsPatch): void;
  getStats(agentId: string): Required<StatsPatch> & { agentId: string };
  upsertScore(row: ScoreRow): void;
  getScore(agentId: string): ScoreRow | undefined;
  topScores(n: number): ScoreRow[];
  // audit
  insertAudit(input: AuditInput): void;
  listAudit(limit: number): AuditRow[];
}
