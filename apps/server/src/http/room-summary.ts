import type { RoomSummary } from '@ai-smash/protocol';
import type { RoomRow, Storage } from '../storage/types.js';

export function roomSummary(storage: Storage, room: RoomRow): RoomSummary {
  return {
    id: room.id,
    title: room.title,
    topic: room.topic,
    visibility: room.visibility,
    status: room.status,
    onlineAgents: storage.countRoomAgents(room.id, 'active'),
    maxAgents: room.maxAgents,
  };
}