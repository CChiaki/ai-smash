import { describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge.ts';
import { helloResponder, readyFrame, startMockPlatform, type MockPlatform } from './mock-platform.ts';

const CHILD_ARGS = ['node', '-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'typing'}));console.log(JSON.stringify({action:'post',text:'回声:'+e.eventId}))}catch{}})`];

function eventFrame(eventId: string, deadlineMs = 20_000): unknown {
  return {
    type: 'event',
    eventId,
    roomId: 'lobby',
    trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
    room: { title: '大厅', topic: null },
    context: { messages: [{ id: 'm_1', roomId: 'lobby', seq: 1, sender: { kind: 'human', name: '阿伟' }, text: 'hi', replyTo: null, createdAt: 't', deletedAt: null }], truncated: false },
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  };
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 10 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('Bridge', () => {
  it('event → 子进程 typing + post；迟到输出被丢弃', async () => {
    const platform: MockPlatform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: CHILD_ARGS,
      log: (l) => logs.push(l), onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_1'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'));
    expect(platform.received.filter((f) => f.type === 'typing')).toHaveLength(1);
    const post = platform.received.find((f) => f.type === 'post');
    expect(post).toMatchObject({ type: 'post', eventId: 'ev_1', text: '回声:ev_1' });
    // 迟到输出（无在途）被丢弃
    platform.sendToLast(eventFrame('ev_2'));
    await waitUntil(() => platform.received.filter((f) => f.type === 'post').length === 2);
    const posts = platform.received.filter((f) => f.type === 'post');
    expect(posts.every((p) => p.eventId === 'ev_2' || p.eventId === 'ev_1')).toBe(true);
    bridge.stop();
    await platform.close();
  });

  it('超时无输出 → 代发 skip；其后的输出丢弃', async () => {
    const sleeper = ['node', '-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{setTimeout(()=>{console.log(JSON.stringify({action:'post',text:'太晚了'}))},2000)})`];
    const platform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: sleeper, deadlineMs: 100,
      log: (l) => logs.push(l), onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_t', 20_000));
    await waitUntil(() => platform.received.some((f) => f.type === 'skip'), 2000);
    expect(platform.received.find((f) => f.type === 'skip')).toMatchObject({ type: 'skip', eventId: 'ev_t' });
    expect(logs.some((l) => l.includes('超时'))).toBe(true);
    const before = platform.received.length;
    await new Promise((r) => setTimeout(r, 2300)); // 迟到的 post 不得上传
    expect(platform.received.filter((f) => f.type === 'post')).toHaveLength(0);
    expect(platform.received.length).toBe(before);
    bridge.stop();
    await platform.close();
  });

  it('子进程崩溃后重启，能继续应答后续 event', async () => {
    // 修正：原稿用 globalThis.__ran 标记“已崩溃过”，但每次重启都是全新进程，
    // 标记无法跨进程保留，子进程会永久崩溃。改为：首启（无环境标记）即退出，
    // 测试在 start() 后设置标记，重启出的子进程（≥10ms 后 spawn）继承标记并正常应答。
    const flaky = ['node', '-e', `if(!process.env.BRIDGE_FLAKY_SECOND){process.exit(1)};const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'post',text:'二次:'+e.eventId}))}catch{}})`];
    const platform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: false, command: flaky,
      log: (l) => logs.push(l), onFatal: () => {},
      baseBackoffMs: 10, baseDelayMs: 10, maxRestarts: 5, windowMs: 60_000,
    });
    bridge.start();
    process.env.BRIDGE_FLAKY_SECOND = '1'; // 首个子进程已同步 spawn（无标记）→ 崩溃；重启子进程带标记
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    // 等观察到崩溃日志后再发 event（重启定时器 10ms 后触发，留裕量），避免把事件写给已死的首个进程
    await waitUntil(() => logs.some((l) => l.includes('崩溃')));
    await new Promise((r) => setTimeout(r, 60));
    platform.sendToLast(eventFrame('ev_ok'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 3000);
    expect(platform.received.find((f) => f.type === 'post')).toMatchObject({ text: '二次:ev_ok' });
    bridge.stop();
    await platform.close();
  });

  it('demo 模式：无子进程，event 后 300ms 内自动回声 post', async () => {
    const platform = await startMockPlatform(helloResponder);
    const bridge = new Bridge({
      url: platform.url, key: 'sk_x', name: '小豆', demo: true,
      log: () => {}, onFatal: () => {}, baseBackoffMs: 10,
    });
    bridge.start();
    await waitUntil(() => platform.received.some((f) => f.type === 'hello'));
    platform.sendToLast(eventFrame('ev_d'));
    await waitUntil(() => platform.received.some((f) => f.type === 'post'), 2000);
    const post = platform.received.find((f) => f.type === 'post');
    expect(post.eventId).toBe('ev_d');
    expect(String(post.text)).toContain('demo');
    bridge.stop();
    await platform.close();
  });
});
