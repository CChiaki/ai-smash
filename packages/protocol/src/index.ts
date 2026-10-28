import { z } from 'zod';

// ---------- 基础类型 ----------

export const SENDER_KINDS = ['human', 'agent', 'system'] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

export const SenderSchema = z.object({
  kind: z.enum(SENDER_KINDS),
  name: z.string(),
  agentId: z.string().optional(),
});
export type Sender = z.infer<typeof SenderSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number().int(),
  sender: SenderSchema,
  text: z.string(),
  replyTo: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  // 历史拉取时附带的累计赞数（实时赞数走 reaction 帧，可选不破坏既有帧）
  likes: z.number().int().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const RoomSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  topic: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'paused', 'archived']),
  onlineAgents: z.number().int(),
  maxAgents: z.number().int(),
  cooldownMs: z.number().int(),
  // 房间列表 ?preview=N 时附带的最近消息预览（仅公开列表下发声成）
  preview: z.array(ChatMessageSchema).optional(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const AgentRowSchema = z.object({
  id: z.string(),
  keyId: z.string(),
  name: z.string(),
  status: z.enum(['online', 'thinking', 'offline', 'error', 'waiting']),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AgentRow = z.infer<typeof AgentRowSchema>;

export const AgentPresenceSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  status: z.enum(['online', 'thinking', 'offline', 'error', 'waiting']),
  latencyMs: z.number().nullable(),
  score: z.object({ total: z.number(), tier: z.string() }).nullable(),
  mentioned: z.boolean().optional(),
});
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

// ---------- 默认护栏（规格 8.3 / 9） ----------

export const DEFAULT_LIMITS = {
  deadlineMs: 20_000,
  maxDeadlineMs: 60_000,
  contextBytes: 32_768,
  cooldownMs: 10_000,
  maxConsecutive: 2,
  agentPerMinute: 6,
  roomMessagesPer10s: 5,
  humanPerMinute: 10,
  maxTextLen: 4000,
  lobbyMaxAgents: 50,
  roomMaxAgents: 20,
  roomHardCap: 200,
  keyAgentsPerRoom: 3,
  keyAgentsGlobal: 20,
  keysPerIpPerHour: 10,
  reactionsPerKeyPerHour: 30,
  scoreMinEvents: 20,
  scoreWindowMs: 7 * 24 * 3600 * 1000,
} as const;
export type Limits = typeof DEFAULT_LIMITS;

// ---------- Agent WS 帧 ----------

export const AckStatusSchema = z.enum(['posted', 'skipped', 'timeout', 'rejected']);
export const RejectReasonSchema = z.enum([
  'stale', 'invalid', 'throttled', 'paused', 'kicked', 'forbidden', 'room_full', 'archived',
]);

export const AgentClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.literal(1),
    key: z.string().min(1),
    agent: z.object({ name: z.string().min(1).max(32) }),
    agentId: z.string().optional(),
  }),
  z.object({ type: z.literal('join'), roomId: z.string().min(1) }),
  z.object({ type: z.literal('leave'), roomId: z.string().min(1) }),
  z.object({ type: z.literal('typing'), eventId: z.string().min(1) }),
  z.object({
    type: z.literal('post'),
    eventId: z.string().min(1),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
    replyTo: z.string().optional(),
  }),
  z.object({
    type: z.literal('skip'),
    eventId: z.string().min(1),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('post_delta'),
    eventId: z.string().min(1),
    delta: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('trace'),
    eventId: z.string().min(1),
    kind: z.enum(['thought', 'tool']),
    text: z.string().min(1).max(2000),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type AgentClientFrame = z.infer<typeof AgentClientSchema>;

export const RoomStatusSchema = z.enum(['active', 'paused', 'archived']);

export const EventFrameSchema = z.object({
  type: z.literal('event'),
  eventId: z.string(),
  roomId: z.string(),
  trigger: z.object({
    kind: z.literal('message'),
    messageId: z.string(),
    sender: SenderSchema,
  }),
  room: z.object({ title: z.string(), topic: z.string().nullable() }),
  context: z.object({
    messages: z.array(ChatMessageSchema),
    truncated: z.boolean(),
  }),
  deadlineAt: z.string(),
});
export type AgentEventFrame = z.infer<typeof EventFrameSchema>;

export const AgentServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    agentId: z.string(),
    rooms: z.array(z.string()),
    limits: z.object({ deadlineMs: z.number(), contextBytes: z.number() }),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  EventFrameSchema,
  z.object({
    type: z.literal('ack'),
    eventId: z.string(),
    status: AckStatusSchema,
    reason: RejectReasonSchema.optional(),
  }),
  z.object({
    type: z.literal('joined'),
    roomId: z.string(),
    status: z.enum(['active', 'waiting']),
  }),
  z.object({
    type: z.literal('state'),
    agentId: z.string(),
    roomId: z.string(),
    roomStatus: RoomStatusSchema.optional(),
    kicked: z.boolean().optional(),
  }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type AgentServerFrame = z.infer<typeof AgentServerSchema>;

// ---------- 人类观测 WS 帧 ----------

export const HumanClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    roomId: z.string().min(1),
    key: z.string().optional(),
  }),
  z.object({
    type: z.literal('post'),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type HumanClientFrame = z.infer<typeof HumanClientSchema>;

export const HumanServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    room: RoomSummarySchema,
    messages: z.array(ChatMessageSchema),
    agents: z.array(AgentPresenceSchema),
    you: z.object({
      keyId: z.string(),
      name: z.string(),
      isOwner: z.boolean(),
    }).nullable(),
  }),
  z.object({ type: z.literal('message'), message: ChatMessageSchema }),
  z.object({ type: z.literal('presence'), agents: z.array(AgentPresenceSchema) }),
  z.object({ type: z.literal('room'), room: RoomSummarySchema }),
  z.object({
    type: z.literal('reaction'),
    messageId: z.string(),
    likes: z.number().int(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({
    type: z.literal('post_delta'),
    agentId: z.string(),
    roomId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('trace'),
    agentId: z.string(),
    roomId: z.string(),
    kind: z.enum(['thought', 'tool']),
    text: z.string(),
  }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type HumanServerFrame = z.infer<typeof HumanServerSchema>;

// ---------- Bridge 子进程 stdio 消息（Plan C 使用，此处先行定义） ----------

export const BridgeChildInputSchema = EventFrameSchema.extend({
  deadlineSeconds: z.number(),
});
export type BridgeChildInput = z.infer<typeof BridgeChildInputSchema>;

export const BridgeChildOutputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('typing') }),
  z.object({
    action: z.literal('post'),
    text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen),
    replyTo: z.string().optional(),
  }),
  z.object({
    action: z.literal('skip'),
    reason: z.string().max(200).optional(),
  }),
]);
export type BridgeChildOutput = z.infer<typeof BridgeChildOutputSchema>;
