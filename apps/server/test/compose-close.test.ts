import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { testConfig } from './http-helpers.js';

// 规格 18 shutdown 顺序：先排空 WS（1001）再关 DB；用完即关，端口 0
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) {
    try { await c(); } catch { /* 兜底：可能已关闭 */ }
  }
});

describe('composeServer close 顺序', () => {
  it('close() 先给 agent WS 发 1001，再关 DB（storage 后续调用抛错）', async () => {
    const handle = composeServer(testConfig());
    await handle.app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => handle.close());
    const port = (handle.app.server.address() as { port: number }).port;

    const raw = newKey();
    handle.storage.createKey({ id: 'key_close', hash: sha256(raw), label: null, createdAt: 't' });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '关豆' } }));
    for (let i = 0; i < 50 && !frames.some((f) => f.type === 'ready'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(frames.some((f) => f.type === 'ready')).toBe(true); // hello/ready 完成

    await expect(handle.close()).resolves.toBeUndefined(); // close 正常 resolve
    expect(await closed).toBe(1001); // socket 收到 server_shutdown 关闭码
    expect(() => handle.storage.getRoom('lobby')).toThrow(); // DB 已关，证明 close 走到最后

    // close 后拒绝新连接：app 已停 listen，新连接会 ECONNREFUSED——这本身就是拒绝的证据；
    // 断言 WS 客户端收到 error 且 3s 内不会成功完成握手/hello
    const connFail = new Promise<void>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
      c.on('error', () => resolve());
      c.on('open', () => reject(new Error('close 后新连接不应成功建立')));
    });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('3s 内新连接未收到 error')), 3_000);
      t.unref?.();
    });
    await Promise.race([connFail, timeout]);
  });

  it('closeAll 后网关 handleUpgrade 直接销毁新 socket（封死关库后写库竞态）', async () => {
    const handle = composeServer(testConfig());
    await handle.app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => handle.close());
    const fakeUpgrade = (gw: { handleUpgrade: (req: any, socket: any, head: Buffer) => void }) => {
      let destroyed = false;
      gw.handleUpgrade(
        { socket: { remoteAddress: '127.0.0.1' } },
        { destroy: () => { destroyed = true; } },
        Buffer.alloc(0),
      );
      return destroyed;
    };
    handle.agentGateway.closeAll();
    handle.humanGateway.closeAll();
    expect(fakeUpgrade(handle.agentGateway)).toBe(true); // 排空后直接销毁
    expect(fakeUpgrade(handle.humanGateway)).toBe(true);
  });
});
