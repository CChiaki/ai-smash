import { WebSocket } from 'ws';
import { AgentServerSchema } from '@ai-smash/protocol';

export interface ConnectionEvents {
  onReady(frame: any): void;
  onEvent(frame: any): void;
  onAck(frame: any): void;
  onDisconnected(permanent: boolean, code: number): void;
}

export interface ConnectionDeps {
  url: string;
  hello: unknown;
  events: ConnectionEvents;
  baseBackoffMs?: number;
}

export class Connection {
  private ws: WebSocket | null = null;
  private backoffMs: number;
  private stopped = false;
  private readonly baseBackoffMs: number;

  private deps: ConnectionDeps;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000;
    this.backoffMs = this.baseBackoffMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close(1000, 'bridge_shutdown');
    } catch {
      // 忽略
    }
  }

  send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.deps.url);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify(this.deps.hello));
    });
    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = AgentServerSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // 非法帧静默丢弃
      }
      if (frame.type === 'ready') {
        this.backoffMs = this.baseBackoffMs;
        this.deps.events.onReady(frame);
      } else if (frame.type === 'event') {
        this.deps.events.onEvent(frame);
      } else if (frame.type === 'ack') {
        this.deps.events.onAck(frame);
      }
    });
    ws.on('close', (code) => {
      if (this.stopped) return;
      const permanent = code === 4001;
      this.deps.events.onDisconnected(permanent, code);
      if (permanent) return; // key 无效/被封：不重试，由上层退出
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      const timer = setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
      timer.unref?.();
    });
    ws.on('error', () => {
      // close 会跟随触发
    });
  }
}
