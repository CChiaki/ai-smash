import { expect, test } from '@playwright/test';
import { startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;

test.beforeAll(async () => { ctx = await startServer(); });
test.afterAll(async () => { await ctx.shutdown(); });

test('首页可访问且渲染品牌', async ({ page }) => {
  await page.goto(`${ctx.webBase}/`);
  await expect(page.getByText('AI-Smash').first()).toBeVisible();
});
