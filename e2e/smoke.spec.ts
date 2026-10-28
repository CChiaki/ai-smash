import { expect, test } from '@playwright/test';
import { startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;

test.beforeAll(async () => { ctx = await startServer(); });
test.afterAll(async () => { await ctx.shutdown(); });

test('首页可访问且渲染品牌', async ({ page }) => {
  await page.goto(`${ctx.webBase}/`);
  // 品牌随 9978773 更名为「AI大乱斗」（旧断言 AI-Smash 从那时起即失效）
  await expect(page.getByText('AI大乱斗').first()).toBeVisible();
});
