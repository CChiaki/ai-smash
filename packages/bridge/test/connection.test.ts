import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { Connection } from '../src/connection.js';

let httpServer: Server;
let wss: WebSocketServer;
const cleanup: Array<() => void> = [];

afterAll(async () => {
  wss?.close();
  httpServer?.close();
  for (const fn of cleanup) fn();
});

async function startPlatform(handler: (ws: WebSocket, received: any[]) => void) {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  const received: any[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    handler(ws, received);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as any).port;
  cleanup.push(() => { for (const s of sockets) s.terminate(); });
  return { url: `ws://127.0.0.1:${port}`, received, sockets };
}

function connect(deps: { events: any; baseBackoffMs?: number }, url: string) {
  const conn = new Connection({ url, hello: { type: 'hello', protocol: 1, key: 'sk_x', agent: { name: '小豆' } }, ...deps });
  conn.start();
  return conn;
}

describe('Connection', () => {
  it('open 后自动发 hello；ready/event/ack 直通回调', async () => {
    let platformWs: WebSocket | undefined;
    const platform = await startPlatform((ws, received) => {
      platformWs = ws;
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        received.push(frame);
        if (frame.type === 'hello') {
          ws.send(JSON.stringify({ type: 'ready', agentId: 'ag_1', rooms: [], limits: { deadlineMs: 20000, contextBytes: 100 } }));
        }
      });
    });
    const got: any[] = [];
    const conn = connect({
      events: {
        onReady: (f: any) => got.push({ kind: 'ready', f }),
        onEvent: (f: any) => got.push({ kind: 'event', f }),
        onAck: (f: any) => got.push({ kind: 'ack', f }),
        onDisconnected: () => {},
      },
    }, platform.url);
    for (let i = 0; i < 50 && (!platformWs || platform.received.length === 0); i++) await new Promise((r) => setTimeout(r, 10));
    expect(platform.received[0].type).toBe('hello');
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got[0].kind).toBe('ready');
    platformWs!.send(JSON.stringify({
      type: 'event', eventId: 'ev_1', roomId: 'room_1',
      trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '人类' } },
      room: { title: '大厅', topic: null },
      context: { messages: [], truncated: false },
      deadlineAt: new Date().toISOString(),
    }));
    platformWs!.send(JSON.stringify({ type: 'ack', eventId: 'ev_1', status: 'posted' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(got.map((g) => g.kind)).toEqual(['ready', 'event', 'ack']);
    conn.stop();
  });

  it('send 在 OPEN 状态转发、非 OPEN 静默丢弃', async () => {
    const platform = await startPlatform((ws, received) => {
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        received.push(frame);
        if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'ready', agentId: 'ag_1', rooms: [], limits: { deadlineMs: 1, contextBytes: 1 } }));
      });
    });
    const conn = connect({ events: { onReady: () => {}, onEvent: () => {}, onAck: () => {}, onDisconnected: () => {} } }, platform.url);
    await new Promise((r) => setTimeout(r, 50));
    conn.send({ type: 'post', eventId: 'ev_1', text: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    expect(platform.received.some((f) => f.type === 'post')).toBe(true);
    conn.stop();
    conn.send({ type: 'post', eventId: 'ev_2', text: 'closed' }); // 不抛错即可
  });

  it('异常断开按退避重连；4001 不重连', async () => {
    let drops = 0;
    const platform = await startPlatform((ws) => {
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d));
        if (frame.type === 'hello') {
          drops += 1;
          if (drops === 1) {
            ws.terminate(); // 异常断开：客户端侧表现为 1006
          } else {
            ws.close(4001, 'invalid_key');
          }
        }
      });
    });
    const disconnects: Array<{ permanent: boolean; code: number }> = [];
    const conn = connect({
      events: {
        onReady: () => {}, onEvent: () => {}, onAck: () => {},
        onDisconnected: (permanent: boolean, code: number) => disconnects.push({ permanent, code }),
      },
      baseBackoffMs: 10,
    }, platform.url);
    for (let i = 0; i < 200 && disconnects.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(disconnects[0]).toEqual({ permanent: false, code: 1006 });
    expect(disconnects[1]).toEqual({ permanent: true, code: 4001 });
    const count = drops;
    await new Promise((r) => setTimeout(r, 100));
    expect(drops).toBe(count); // 4001 后不再重连
    conn.stop();
  });
});
