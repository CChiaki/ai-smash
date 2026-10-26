import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildRunner, type ChildEvents } from '../src/child.ts';

function echoAgent(): string[] {
  return ['node', '-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const e=JSON.parse(l);console.log(JSON.stringify({action:'post',text:'回声:'+e.eventId}))}catch{}})`];
}

function garbageAgent(): string[] {
  return ['node', '-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',()=>{console.log('这不是JSON')})`];
}

function crashAgent(): string[] {
  return ['node', '-e', 'process.exit(1)'];
}

function makeEvents() {
  const outputs: Array<{ frame: any; raw: string }> = [];
  let crashes = 0;
  let fatal = 0;
  const events: ChildEvents = {
    onOutput: (frame, raw) => outputs.push({ frame, raw }),
    onCrash: () => { crashes += 1; },
    onFatal: () => { fatal += 1; },
  };
  return { outputs, crashes: () => crashes, fatal: () => fatal, events };
}

afterEach(() => { vi.useRealTimers(); });

describe('ChildRunner', () => {
  it('回声子进程：sendEvent → stdout post 帧', async () => {
    const { outputs, events } = makeEvents();
    const runner = new ChildRunner(echoAgent(), events, { baseDelayMs: 10 });
    runner.start();
    runner.sendEvent({ eventId: 'ev_1', hello: 1 });
    for (let i = 0; i < 50 && outputs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(outputs[0]?.frame).toEqual({ action: 'post', text: '回声:ev_1' });
  });

  it('非法输出回调 null 与原文', async () => {
    const { outputs, events } = makeEvents();
    const runner = new ChildRunner(garbageAgent(), events, { baseDelayMs: 10 });
    runner.start();
    runner.sendEvent({ eventId: 'ev_1' });
    for (let i = 0; i < 50 && outputs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(outputs[0]?.frame).toBeNull();
    expect(outputs[0]?.raw).toContain('这不是JSON');
  });

  it('崩溃退避重启，超过窗口内上限触发 onFatal', async () => {
    const { crashes, fatal, events } = makeEvents();
    const runner = new ChildRunner(crashAgent(), events, { baseDelayMs: 10, maxRestarts: 2, windowMs: 60_000 });
    runner.start();
    for (let i = 0; i < 100 && fatal() === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    expect(fatal()).toBe(1);
    expect(crashes()).toBeGreaterThanOrEqual(3); // 初次 + 重启 2 次
  });

  it('stop 后不再重启', async () => {
    const { crashes, events } = makeEvents();
    const runner = new ChildRunner(crashAgent(), events, { baseDelayMs: 10, maxRestarts: 99 });
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    const before = crashes();
    runner.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(crashes()).toBeLessThanOrEqual(before + 1);
  });
});
