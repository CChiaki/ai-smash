import type { AgentPresence, ChatMessage, RoomSummary, TraceKind } from '@ai-smash/protocol';

export interface RoomYou {
  keyId: string;
  name: string;
  isOwner: boolean;
}

export interface RoomState {
  room: RoomSummary | null;
  messages: ChatMessage[];
  agents: AgentPresence[];
  likes: Record<string, number>;
  ready: boolean;
  you: RoomYou | null;
  // agentId → 正在流式的内容（2.1 post_delta；post 落库/ready/reset 时清除）
  streaming: Record<string, { name: string; text: string }>;
  // agentId → 最近 20 条 trace（2.2 trace 帧；post 落库/presence 非 thinking/ready/reset 时清除）
  traces: Record<string, Array<{ kind: TraceKind; text: string }>>;
}

export const initialRoomState: RoomState = {
  room: null, messages: [], agents: [], likes: {}, ready: false, you: null, streaming: {}, traces: {},
};

export type RoomAction =
  | { type: 'ready'; room: RoomSummary; messages: ChatMessage[]; agents: AgentPresence[]; you: RoomYou | null }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; agents: AgentPresence[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'reaction'; messageId: string; likes: number }
  | { type: 'delta'; agentId: string; delta: string }
  | { type: 'trace'; agentId: string; kind: TraceKind; text: string }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true, you: action.you, streaming: {}, traces: {} };
    case 'message': {
      // 全量去重（some）：乱序重放时重复 id 可能不在末条
      if (state.messages.some((m) => m.id === action.message.id)) return state;
      // 同名 agent 的 post 落库即代表流式结束：清除其流式条目与 trace 面板
      return {
        ...state,
        messages: [...state.messages, action.message],
        streaming: action.message.sender.agentId
          ? Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== action.message.sender.agentId))
          : state.streaming,
        traces: action.message.sender.agentId
          ? Object.fromEntries(Object.entries(state.traces).filter(([id]) => id !== action.message.sender.agentId))
          : state.traces,
      };
    }
    case 'presence': {
      // 引擎在 event 终态后 emitPresence：skip/timeout/rejected 的 Agent 不再 thinking，
      // 其流式幽灵气泡与 trace 面板随之清除（post 落库由 'message' case 清除）
      const thinking = new Set(action.agents.filter((a) => a.status === 'thinking').map((a) => a.agentId));
      const streaming: RoomState['streaming'] = {};
      for (const [agentId, entry] of Object.entries(state.streaming)) {
        if (thinking.has(agentId)) streaming[agentId] = entry;
      }
      const traces: RoomState['traces'] = {};
      for (const [agentId, list] of Object.entries(state.traces)) {
        if (thinking.has(agentId)) traces[agentId] = list;
      }
      return { ...state, agents: action.agents, streaming, traces };
    }
    case 'room':
      return { ...state, room: action.room };
    case 'reaction':
      return { ...state, likes: { ...state.likes, [action.messageId]: action.likes } };
    case 'delta': {
      const name = state.agents.find((a) => a.agentId === action.agentId)?.name ?? action.agentId;
      const prev = state.streaming[action.agentId];
      return {
        ...state,
        streaming: { ...state.streaming, [action.agentId]: { name, text: (prev?.text ?? '') + action.delta } },
      };
    }
    case 'trace': {
      const list = [...(state.traces[action.agentId] ?? []), { kind: action.kind, text: action.text }].slice(-20);
      return { ...state, traces: { ...state.traces, [action.agentId]: list } };
    }
    case 'reset':
      return initialRoomState;
  }
}
