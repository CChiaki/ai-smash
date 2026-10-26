import type { AgentPresence, ChatMessage, RoomSummary } from '@ai-smash/protocol';

export interface RoomState {
  room: RoomSummary | null;
  messages: ChatMessage[];
  agents: AgentPresence[];
  likes: Record<string, number>;
  ready: boolean;
}

export const initialRoomState: RoomState = {
  room: null, messages: [], agents: [], likes: {}, ready: false,
};

export type RoomAction =
  | { type: 'ready'; room: RoomSummary; messages: ChatMessage[]; agents: AgentPresence[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'presence'; agents: AgentPresence[] }
  | { type: 'room'; room: RoomSummary }
  | { type: 'reaction'; messageId: string; likes: number }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'ready':
      return { room: action.room, messages: action.messages, agents: action.agents, likes: state.likes, ready: true };
    case 'message': {
      const last = state.messages.at(-1);
      if (last && last.id === action.message.id) return state;
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
