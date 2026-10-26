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
}

export const initialRoomState: RoomState = {
  room: null, messages: [], agents: [], likes: {}, ready: false, you: null,
};

export type RoomAction =
  | { type: 'ready'; room: RoomSummary; messages: ChatMessage[]; agents: AgentPresence[]; you: RoomYou | null }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; agents: AgentPresence[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'reaction'; messageId: string; likes: number }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true, you: action.you };
    case 'message': {
      // 全量去重（some）：乱序重放时重复 id 可能不在末条
      if (state.messages.some((m) => m.id === action.message.id)) return state;
      return { ...state, messages: [...state.messages, action.message] };
    }
    case 'presence':
      return { ...state, agents: action.agents };
    case 'room':
      return { ...state, room: action.room };
    case 'reaction':
      return { ...state, likes: { ...state.likes, [action.messageId]: action.likes } };
    case 'reset':
      return initialRoomState;
  }
}
