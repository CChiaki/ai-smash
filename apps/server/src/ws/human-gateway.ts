import { HumanClientSchema } from '@ai-smash/protocol';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { toChatMessage } from '../engine/chat.js';
import { sha256 } from '../ids.js';
import { Topics } from '../topics.js';
import { humanName } from '../http/auth.js';
import { roomSummary } from '../http/room-summary.js';

export class HumanGateway {
  private wss = new WebSocketServer({ noServer: true });
  private rooms = new Map<string, Set<WebSocket>>();

  constructor(private deps: AppDeps) {
    deps.bus.on(Topics.messageNew, (p: any) => {
      this.broadcast(p.message.roomId, { type: 'message', message: p.message });
    });
    deps.bus.on(Topics.presence, (p: any) => {
      this.broadcast(p.roomId, { type: 'presence', agents: this.deps.engine.listPresence(p.roomId) });
    });
    deps.bus.on(Topics.agentState, (p: any) => {
      this.broadcast(p.roomId, { type: 'presence', agents: this.deps.engine.listPresence(p.roomId) });
    });
    deps.bus.on(Topics.roomUpdate, (p: any) => {
      const room = this.deps.storage.getRoom(p.room.id);
      if (room) this.broadcast(room.id, { type: 'room', room: roomSummary(this.deps.storage, room) });
    });
    deps.bus.on(Topics.reaction, (p: any) => {
      this.broadcast(p.roomId, { type: 'reaction', messageId: p.messageId, likes: p.likes });
    });
  }

  handleUpgrade(req: any, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  onlineCount(): number {
    let n = 0;
    for (const set of this.rooms.values()) n += set.size;
    return n;
  }

  private broadcast(roomId: string, frame: unknown): void {
    for (const ws of this.rooms.get(roomId) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }
  }

  private send(ws: WebSocket, frame: unknown): void {
    ws.send(JSON.stringify(frame));
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 忽略
    }
  }

  private onConnection(ws: WebSocket): void {
    let joined: { roomId: string; keyId: string | null } | null = null;

    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = HumanClientSchema.parse(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!joined) {
        if (frame.type !== 'hello') return this.close(ws, 4000, 'hello_first');
        const room = this.deps.storage.getRoom(frame.roomId);
        if (!room) return this.close(ws, 4004, 'room_not_found');
        let keyId: string | null = null;
        let keyRow = null;
        if (frame.key) {
          keyRow = this.deps.storage.getKeyByHash(sha256(frame.key));
          if (!keyRow || keyRow.status === 'banned') return this.close(ws, 4001, 'invalid_key');
          keyId = keyRow.id;
        }
        if (room.visibility === 'private') {
          const allowed = keyId && this.deps.storage.getMember(room.id, keyId);
          if (!allowed) return this.close(ws, 4003, 'forbidden');
        }
        joined = { roomId: room.id, keyId };
        let set = this.rooms.get(room.id);
        if (!set) {
          set = new Set();
          this.rooms.set(room.id, set);
        }
        set.add(ws);
        this.send(ws, {
          type: 'ready',
          room: roomSummary(this.deps.storage, room),
          messages: this.deps.storage.listMessages(room.id, { limit: 50 }).map(toChatMessage),
          agents: this.deps.engine.listPresence(room.id),
          you: keyRow
            ? { keyId: keyRow.id, name: humanName(keyRow), isOwner: room.ownerKeyId === keyRow.id }
            : null,
        });
        return;
      }
      if (frame.type === 'ping') {
        this.send(ws, { type: 'pong', t: frame.t });
        return;
      }
      if (frame.type === 'post') {
        if (!joined.keyId) {
          this.send(ws, { type: 'error', code: 'unauthorized', message: '发言需要 key' });
          return;
        }
        const key = this.deps.storage.getKey(joined.keyId);
        if (!key || key.status === 'banned') return this.close(ws, 4001, 'invalid_key');
        const room = this.deps.storage.getRoom(joined.roomId);
        if (room?.visibility === 'private' && !this.deps.storage.getMember(room.id, key.id)) {
          this.send(ws, { type: 'error', code: 'forbidden', message: '不是房间成员' });
          return;
        }
        try {
          this.deps.engine.humanPost(joined.roomId, key.id, humanName(key), frame.text);
        } catch (e: any) {
          this.send(ws, { type: 'error', code: e.code ?? 'post_failed', message: String(e.message) });
        }
        return;
      }
    });

    ws.on('close', () => {
      if (!joined) return;
      const set = this.rooms.get(joined.roomId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.rooms.delete(joined.roomId);
      }
    });
  }
}
