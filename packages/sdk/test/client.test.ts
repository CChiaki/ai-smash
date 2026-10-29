import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/client.js';

let httpServer: Server;
let wss: WebSocketServer;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets.length = 0;
  await new Promise<void>((r) => wss?.close(() => r()));
  await new Promise<void>((r) => httpServer?.close(() => r()));
});

function startPlatform(onHello: (ws: WebSocket, received: any[], hello: any) => void): Promise<{ url: string; received: any[] }> {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  const received: any[] = [];
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as any).port;
      wss.on('connection', (ws) => {
        sockets.push(ws);
        ws.on('message', (d) => {
          const frame = JSON.parse(String(d));
          received.push(frame);
          if (frame.type === 'hello') onHello(ws, received, frame);
        });
      });
      resolve({ url: `ws://127.0.0.1:${port}/ws/agent`, received });
    });
  });
}

function readyFrame(agentId = 'ag_1', rooms: string[] = ['lobby']): unknown {
  return { type: 'ready', agentId, rooms, limits: { deadlineMs: 20000, contextBytes: 32768 } };
}

function eventFrame(eventId: string, deadlineSeconds = 5): unknown {
  return {
    type: 'event', eventId, roomId: 'lobby',
    trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
    room: { title: '公共大厅', topic: null },
    context: { messages: [{ id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'human', name: '阿伟' }, text: '来聊聊', replyTo: null, createdAt: 't', deletedAt: null }], truncated: false },
    deadlineAt: new Date(Date.now() + deadlineSeconds * 1000).toISOString(),
    deadlineSeconds,
  };
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('createAgent · 启动期被拒', () => {
  it('error 帧 + 4003 关闭：立即以平台原因 reject，不等 15s 超时', async () => {
    const platform = await startPlatform((ws) => {
      ws.send(JSON.stringify({ type: 'error', code: 'forbidden', message: '该 key 在此房间的 Agent 数已达上限' }));
      ws.close(4003, 'forbidden');
    });
    const t0 = Date.now();
    await expect(createAgent(
      { key: 'sk_x', name: '超额豆', url: platform.url },
      { onEvent: async () => {} },
    )).rejects.toThrow(/Agent 数已达上限/);
    expect(Date.now() - t0).toBeLessThan(5000); // 远小于 15s 超时
  });
});

describe('createAgent（SDK）', () => {
  it('hello → ready → onReady；event → typing + post（自动绑定 eventId 与 replyTo）', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const seen: any[] = [];
    const agent = await createAgent(
      { key: 'sk_x', name: '小豆', url: platform.url },
      {
        onReady: (info) => seen.push(['ready', info.agentId]),
        onEvent: async (e, helpers) => {
          helpers.typing();
          return { action: 'post', text: '我来说两句', replyTo: e.trigger?.messageId };
        },
      },
    );
    expect(agent.agentId).toBe('ag_1');
    await waitUntil(() => seen.some((s) => s[0] === 'ready'));
    sockets[0].send(JSON.stringify(eventFrame('ev_1')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'));
    expect(platform.received.find((f) => f.type === 'typing')).toMatchObject({ eventId: 'ev_1' });
    expect(platform.received.find((f) => f.type === 'post')).toEqual({ type: 'post', eventId: 'ev_1', text: '我来说两句', replyTo: 'm_1' });
    agent.stop();
  });

  it('onEvent 超时 → SDK 代发 skip，不记超时', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '慢豆', url: platform.url, deadlineMs: 400 },
      { onEvent: () => new Promise(() => { /* 永不返回 */ }) },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_2', 5)));
    await waitUntil(() => platform.received.some((f) => f.type === 'skip'), 3000);
    expect(platform.received.find((f) => f.type === 'skip')).toMatchObject({ eventId: 'ev_2', reason: '处理超时' });
    agent.stop();
  });

  it('onEvent 抛错 → skip；返回 void → skip；4001 → onFatal 且 stop 幂等', async () => {
    const platform = await startPlatform((ws, _r, hello) => {
      ws.send(JSON.stringify(readyFrame('ag_9')));
      void hello;
    });
    let fatal = '';
    const agent = await createAgent(
      { key: 'sk_bad', name: '背时豆', url: platform.url },
      {
        onEvent: async () => { throw new Error('LLM 炸了'); },
        onFatal: (r) => { fatal = r; },
      },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_3', 5)));
    await waitUntil(() => platform.received.some((f) => f.type === 'skip'));
    expect(platform.received.find((f) => f.type === 'skip')).toMatchObject({ eventId: 'ev_3', reason: '处理出错' });
    sockets[0].close(4001, 'invalid_key');
    await waitUntil(() => fatal.length > 0, 3000);
    expect(fatal).toContain('4001');
    agent.stop();
    agent.stop(); // 幂等
  });

  it('rooms：ready 后对非大厅房间自动 join；handle.joinRoom 可再加', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame('ag_2', ['lobby']))));
    const agent = await createAgent(
      { key: 'sk_x', name: '串场豆', url: platform.url, rooms: ['rm_a', 'lobby'] },
      { onEvent: async () => undefined },
    );
    await waitUntil(() => platform.received.some((f) => f.type === 'join' && f.roomId === 'rm_a'));
    expect(platform.received.filter((f) => f.type === 'join')).toHaveLength(1); // lobby 不重复 join
    agent.joinRoom('rm_b');
    await waitUntil(() => platform.received.some((f) => f.type === 'join' && f.roomId === 'rm_b'));
    agent.stop();
  });

  it('helpers.delta 逐段发送 post_delta；settled 后忽略', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '流式豆', url: platform.url },
      { onEvent: async (e, { typing, delta }) => {
          typing();
          delta('第一段');
          delta('第二段');
          return { action: 'post', text: '第一段第二段' };
        } },
    );
    void agent;
    sockets[0].send(JSON.stringify(eventFrame('ev_4')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    const deltas = platform.received.filter((f) => f.type === 'post_delta');
    expect(deltas.map((f) => f.delta)).toEqual(['第一段', '第二段']);
    expect(deltas.every((f) => f.eventId === platform.received.find((x) => x.type === 'post')!.eventId)).toBe(true);
  });

  it('delta 超长自动切片为 2000 字帧', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '长文豆', url: platform.url },
      { onEvent: async (e, { delta }) => { delta('x'.repeat(4500)); return { action: 'post', text: 'x'.repeat(4500) }; } },
    );
    void agent;
    sockets[0].send(JSON.stringify(eventFrame('ev_5')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    const deltas = platform.received.filter((f) => f.type === 'post_delta');
    expect(deltas).toHaveLength(3); // 2000 + 2000 + 500
    expect(deltas.every((f) => f.delta.length <= 2000)).toBe(true);
  });

  it('helpers.trace 上报；settled 后静默', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    let late: { trace: (kind: 'thought' | 'tool', text: string) => void } | undefined;
    const agent = await createAgent(
      { key: 'sk_x', name: '思考豆', url: platform.url },
      { onEvent: async (e, helpers) => {
          helpers.trace('thought', '先想');
          helpers.trace('tool', 'x'.repeat(2500));
          helpers.trace('tool', ''); // 空串静默
          late = helpers;
          return { action: 'post', text: '答案' };
        } },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_t')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'));
    const traces = platform.received.filter((f) => f.type === 'trace');
    expect(traces[0]).toMatchObject({ eventId: 'ev_t', kind: 'thought', text: '先想' });
    expect(traces[1].text).toHaveLength(2000); // 截断
    late!.trace('thought', '晚到的想法'); // settled 后静默
    expect(platform.received.filter((f) => f.type === 'trace')).toHaveLength(2);
    agent.stop();
  });

  it('onEvent 返回 attachments → post 帧携带', async () => {
    const platform = await startPlatform((ws) => ws.send(JSON.stringify(readyFrame())));
    const agent = await createAgent(
      { key: 'sk_x', name: '画图豆', url: platform.url },
      { onEvent: async () => ({ action: 'post', text: '看图', attachments: [{ kind: 'image', url: 'https://x.com/a.png' }] } as any) },
    );
    sockets[0].send(JSON.stringify(eventFrame('ev_a')));
    await waitUntil(() => platform.received.some((f) => f.type === 'post' && (f as any).attachments));
    expect(platform.received.find((f) => f.type === 'post')).toMatchObject({ attachments: [{ kind: 'image', url: 'https://x.com/a.png' }] });
    agent.stop();
  });
});
