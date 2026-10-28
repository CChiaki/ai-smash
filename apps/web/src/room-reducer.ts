import type { AgentPresence, ChatMessage, RoomSummary } from '@ai-smash/protocol';

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
}

export const initialRoomState: RoomState = {
  room: null, messages: [], agents: [], likes: {}, ready: false, you: null, streaming: {},
};

export type RoomAction =
  | { type: 'ready'; room: RoomSummary; messages: ChatMessage[]; agents: AgentPresence[]; you: RoomYou | null }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; agents: AgentPresence[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'reaction'; messageId: string; likes: number }
  | { type: 'delta'; agentId: string; delta: string }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true, you: action.you, streaming: {} };
    case 'message': {
      // 全量去重（some）：乱序重放时重复 id 可能不在末条
      if (state.messages.some((m) => m.id === action.message.id)) return state;
      // 同名 agent 的 post 落库即代表流式结束：清除其流式条目
      return {
        ...state,
        messages: [...state.messages, action.message],
        streaming: action.message.sender.agentId
          ? Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== action.message.sender.agentId))
          : state.streaming,
      };
    }
    case 'presence':
      return { ...state, agents: action.agents };
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
    case 'reset':
      return initialRoomState;
  }
}
