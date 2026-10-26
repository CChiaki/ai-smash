import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export interface MockPlatform {
  url: string;
  received: any[];
  sockets: WebSocket[];
  sendToLast(frame: unknown): void;
  close(): Promise<void>;
}

export function startMockPlatform(handler?: (ws: WebSocket, received: any[]) => void): Promise<MockPlatform> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received: any[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    handler?.(ws, received);
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as any).port;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        sockets,
        sendToLast: (frame) => {
          const ws = sockets.at(-1);
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
        },
        close: async () => {
          for (const s of sockets) s.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

export function readyFrame(agentId = 'ag_1'): unknown {
  return { type: 'ready', agentId, rooms: ['lobby'], limits: { deadlineMs: 20000, contextBytes: 32768 } };
}

export function helloResponder(ws: WebSocket, received: any[]): void {
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d));
    received.push(frame);
    if (frame.type === 'hello') ws.send(JSON.stringify(readyFrame()));
  });
}
