import { describe, expect, it } from 'vitest';
import { runBridge } from '../src/cli.ts';
import { helloResponder, startMockPlatform, type MockPlatform } from './mock-platform.ts';

describe('runBridge', () => {
  it('参数错误返回 2 并打印用法', () => {
    const errors: string[] = [];
    const code = runBridge(['--name', 'x'], { log: () => {}, error: (l) => errors.push(l), onFatal: () => {} });
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('用法');
  });

  it('demo 模式接入 mock 平台并回声（冒烟）', async () => {
    const platform: MockPlatform = await startMockPlatform(helloResponder);
    const logs: string[] = [];
    const code = runBridge(
      ['demo', '--key', 'sk_x', '--name', '小豆', '--url', platform.url],
      { log: (l) => logs.push(l), error: () => {}, onFatal: () => {} },
    );
    expect(code).toBe(0);
    // helloResponder 在连接建立时自动应答 ready；等握手完成后下发 event
    for (let i = 0; i < 100 && !logs.some((l) => l.includes('ready')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    platform.sendToLast(eventFrameOf('ev_cli'));
    for (let i = 0; i < 200 && !platform.received.some((f) => f.type === 'post'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(platform.received.some((f) => f.type === 'post')).toBe(true);
    await platform.close();
  });
});

function eventFrameOf(eventId: string): unknown {
  return {
    type: 'event', eventId, roomId: 'lobby',
    trigger: { kind: 'message', messageId: 'm_1', sender: { kind: 'human', name: '阿伟' } },
    room: { title: '大厅', topic: null },
    context: { messages: [], truncated: false },
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
  };
}
