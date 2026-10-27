import { describe, expect, it, vi } from 'vitest';
import { buildMessages, callLLM, extractReply, loadDemoEnv, readConfig } from '../src/agent.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EVENT = {
  eventId: 'ev_1',
  trigger: { kind: 'message', messageId: 'm_9', sender: { kind: 'human', name: '阿伟' } },
  context: {
    messages: [
      { id: 'm_8', sender: { kind: 'agent', name: '小豆' }, text: '评分是七三开' },
      { id: 'm_9', sender: { kind: 'human', name: '阿伟' }, text: '那热度分怎么算？' },
    ],
    truncated: false,
  },
  deadlineSeconds: 20,
};

describe('readConfig / loadDemoEnv', () => {
  it('缺配置报错并提示 .env 位置', () => {
    expect(() => readConfig({} as NodeJS.ProcessEnv)).toThrow(/apps\/demo\/\.env/);
  });
  it('读取完整配置与默认人设', () => {
    const cfg = readConfig({ LLM_BASE_URL: 'https://api.x.com/v1/', LLM_API_KEY: 'sk_t', LLM_MODEL: 'm1' } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe('https://api.x.com/v1'); // 去尾斜杠
    expect(cfg.model).toBe('m1');
    expect(cfg.persona.length).toBeGreaterThan(10);
  });
  it('loadDemoEnv 读指定文件且不覆盖已有变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aismash-demo-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'DEMO_TEST_A=1\nDEMO_TEST_B="两"\n');
    process.env.DEMO_TEST_A = 'env优先';
    loadDemoEnv(file);
    expect(process.env.DEMO_TEST_A).toBe('env优先');
    expect(process.env.DEMO_TEST_B).toBe('两');
    delete process.env.DEMO_TEST_A;
    delete process.env.DEMO_TEST_B;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildMessages', () => {
  it('system 含人设与规则；user 含转写与触发内容', () => {
    const msgs = buildMessages({ ...EVENT, persona: '毒舌评论员\n' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('毒舌评论员');
    expect(msgs[1].content).toContain('小豆：评分是七三开');
    expect(msgs[1].content).toContain('阿伟（人类）：那热度分怎么算？');
    expect(msgs[1].content).toContain('那热度分怎么算？');
  });
  it('无历史时给开场提示', () => {
    const msgs = buildMessages({ context: { messages: [] } });
    expect(msgs[1].content).toContain('还没有人说话');
  });
});

describe('extractReply / callLLM', () => {
  it('extractReply 取 choices[0].content 并 trim', () => {
    expect(extractReply({ choices: [{ message: { content: '  hi \n' } }] })).toBe('hi');
    expect(extractReply({})).toBe('');
  });
  it('callLLM 组装 OpenAI 兼容请求并返回文本', async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.x.com/v1/chat/completions');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('m1');
      expect(body.messages).toEqual([
        { role: 'system', content: '人设' },
        { role: 'user', content: 'hi' },
      ]);
      expect(init.headers.authorization).toBe('Bearer sk_t');
      return new Response(JSON.stringify({ choices: [{ message: { content: '我来说两句' } }] }), { status: 200 });
    }) as any;
    const out = await callLLM({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk_t', model: 'm1', persona: '' }, [
      { role: 'system', content: '人设' },
      { role: 'user', content: 'hi' },
    ], 5000, fetchMock);
    expect(out).toBe('我来说两句');
  });
  it('非 2xx 抛错（上层转 skip）', async () => {
    const fetchMock = (async () => new Response('rate limited', { status: 429 })) as any;
    await expect(callLLM({ baseUrl: 'https://x', apiKey: 'k', model: 'm', persona: '' }, [{ role: 'user', content: 'x' }], 2000, fetchMock)).rejects.toThrow(/429/);
  });
});
