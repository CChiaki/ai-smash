import { expect, test } from '@playwright/test';
import { connectAgent, newKey, startServer, type AgentClient, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;
let targetKey: string;
let agent: AgentClient;

test.beforeAll(async () => {
  ctx = await startServer();
  targetKey = await newKey(ctx.base, '被封豆');
  agent = await connectAgent(ctx.base, targetKey, '违规豆');
});

test.afterAll(async () => {
  agent?.close();
  // 等服务端处理完 ws close（会写 agents 表），再关 DB
  await new Promise((r) => setTimeout(r, 200));
  await ctx.shutdown();
});

test('管理端登录 → 概览 → 封禁 key → agent 断线', async ({ page }) => {
  await page.goto(`${ctx.base}/admin`);
  await page.getByPlaceholder('ADMIN_TOKEN').fill('e2e-admin-token');
  await page.getByText('进入').click();
  // keys 文案同时出现在概览卡片和 tab，用 tab 按钮定位避免 strict mode 冲突
  await expect(page.getByRole('button', { name: 'keys' })).toBeVisible();
  await page.getByText('封禁').first().click();
  // 简化断言：封禁 key → 服务端 forceDisconnect 其 agent → 轮询 admin agents 接口直到 status==='offline'
  await expect.poll(async () => {
    const res = await fetch(`${ctx.base}/api/admin/agents`, { headers: { 'x-admin-token': 'e2e-admin-token' } });
    const rows = (await res.json()).rows as any[];
    return rows.find((r) => r.name === '违规豆')?.status;
  }, { timeout: 10_000 }).toBe('offline');
});
