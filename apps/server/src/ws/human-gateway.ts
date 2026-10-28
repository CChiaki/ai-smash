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
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private rooms = new Map<string, Set<WebSocket>>();
  // 安全：每 IP 连接上限
  private ipCounts = new Map<string, number>();
  private static readonly MAX_PER_IP = 50;
  // 排空后拒绝新连接，与 agent 网关保持一致
  private closed = false;

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
    deps.bus.on(Topics.postDelta, (p: any) => {
      this.broadcast(p.roomId, { type: 'post_delta', agentId: p.agentId, roomId: p.roomId, delta: p.delta });
    });
  }

  handleUpgrade(req: any, socket: Duplex, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const n = this.ipCounts.get(ip) ?? 0;
    if (n >= HumanGateway.MAX_PER_IP) {
      socket.destroy();
      return;
    }
    this.ipCounts.set(ip, n + 1);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('close', () => {
        const c = (this.ipCounts.get(ip) ?? 1) - 1;
        if (c <= 0) this.ipCounts.delete(ip);
        else this.ipCounts.set(ip, c);
      });
      this.onConnection(ws);
    });
  }

  onlineCount(): number {
    let n = 0;
    for (const set of this.rooms.values()) n += set.size;
    return n;
  }

  // 规格 18 shutdown 顺序：先对所有观测 WS 发 1001，清空注册表后再关 DB
  closeAll(): void {
    this.closed = true;
    for (const set of this.rooms.values()) {
      for (const ws of set) { try { ws.close(1001, 'server_shutdown'); } catch { /* 忽略 */ } }
    }
    this.rooms.clear();
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
    // 安全：首帧鉴权超时，防止未完成握手的连接长期占用
    const authTimer = setTimeout(() => {
      if (!joined) this.close(ws, 4001, 'auth_timeout');
    }, 10_000);
    authTimer.unref?.();
    // 规格 6.4：服务端 30s 协议级 ping，60s 无 pong 断开（对齐 agent 网关）
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 60_000) return this.close(ws, 4000, 'heartbeat_timeout');
      ws.ping();
    }, 30_000);
    heartbeat.unref?.();
    ws.on('pong', () => { lastPong = Date.now(); });
    // maxPayload 超限等协议错误会以 'error' 事件到达；无监听会变成 uncaughtException
    ws.on('error', () => {});

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
        clearTimeout(authTimer);
        let set = this.rooms.get(room.id);
        if (!set) {
          set = new Set();
          this.rooms.set(room.id, set);
        }
        set.add(ws);
        this.send(ws, {
          type: 'ready',
          room: roomSummary(this.deps.storage, room),
          messages: this.deps.storage.listMessages(room.id, { limit: 50 })
            .map((m) => ({ ...toChatMessage(m), likes: this.deps.storage.countLikes(m.id) })),
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
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (!joined) return;
      const set = this.rooms.get(joined.roomId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.rooms.delete(joined.roomId);
      }
    });
  }
}
