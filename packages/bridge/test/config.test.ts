import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.ts';

describe('parseArgs', () => {
  it('解析 -- 形式的 command', () => {
    const c = parseArgs(['--key', 'sk_x', '--name', '小豆', '--', 'python', 'agent.py']);
    expect(c).toMatchObject({ key: 'sk_x', name: '小豆', demo: false });
    expect(c.command).toEqual(['python', 'agent.py']);
  });
  it('解析 --command 与 --url/--deadline/--agent-id', () => {
    const c = parseArgs([
      '--key', 'sk_x', '--name', '小豆', '--url', 'ws://h:1/ws/agent',
      '--deadline', '5000', '--agent-id', 'ag_1', '--command', 'node agent.js --port 1',
    ]);
    expect(c.url).toBe('ws://h:1/ws/agent');
    expect(c.deadlineMs).toBe(5000);
    expect(c.agentId).toBe('ag_1');
    expect(c.command).toEqual(['node', 'agent.js', '--port', '1']);
  });
  it('demo 模式无需 command', () => {
    expect(parseArgs(['demo', '--key', 'sk_x', '--name', '小豆']).demo).toBe(true);
  });
  it('缺 key 报错；非 demo 缺 command 报错；未知参数报错', () => {
    expect(() => parseArgs(['--name', 'x', '--', 'a'])).toThrow(/--key/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x'])).toThrow(/--command/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--wat', '1', '--', 'a'])).toThrow(/未知参数/);
  });
  it('deadline 越界报错', () => {
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--deadline', '0', '--', 'a'])).toThrow(/--deadline/);
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--deadline', '60001', '--', 'a'])).toThrow(/--deadline/);
  });
  it('--proxy 合法与非法', () => {
    expect(parseArgs(['--key', 'k', '--name', 'x', '--proxy', 'http://p:8080', '--', 'a']).proxyUrl).toBe('http://p:8080');
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--proxy', 'socks5://p', '--', 'a'])).toThrow(/--proxy/);
    // 仅前缀但不可解析（如 http://）同样拒绝
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--proxy', 'http://', '--', 'a'])).toThrow(/--proxy/);
    // 缺取值不静默吞掉（若静默会落到「需要 --command」错误而非 --proxy）
    expect(() => parseArgs(['--key', 'k', '--name', 'x', '--proxy'])).toThrow(/--proxy/);
  });
});

describe('env 兜底与 --room', () => {
  it('AI_SMASH_KEY / AI_SMASH_NAME / AI_SMASH_PROXY 兜底', () => {
    vi.stubEnv('AI_SMASH_KEY', 'sk_env');
    vi.stubEnv('AI_SMASH_NAME', '环境豆');
    vi.stubEnv('AI_SMASH_PROXY', 'http://p:7890');
    const c = parseArgs(['--', 'a']);
    expect(c).toMatchObject({ key: 'sk_env', name: '环境豆', proxyUrl: 'http://p:7890' });
    vi.unstubAllEnvs();
  });
  it('--room 可重复收集', () => {
    const c = parseArgs(['--key', 'k', '--name', 'x', '--room', 'rm_1', '--room', 'rm_2', '--', 'a']);
    expect(c.rooms).toEqual(['rm_1', 'rm_2']);
  });
});
