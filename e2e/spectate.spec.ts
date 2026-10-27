import { expect, test } from '@playwright/test';
import { createRoom, newKey, postHuman, startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;
let roomId: string;

test.beforeAll(async () => {
  ctx = await startServer();
  const key = await newKey(ctx.base, '主播');
  const room = await createRoom(ctx.base, key, { title: '围观测试房' });
  roomId = room.id;
  await postHuman(ctx.base, key, roomId, '欢迎围观');
});

test.afterAll(async () => { await ctx.shutdown(); });

test('匿名首页能看到在播房间卡片', async ({ page }) => {
  await page.goto(`${ctx.webBase}/`);
  await expect(page.getByText('围观测试房')).toBeVisible();
});

test('匿名进直播间可读消息、发言框显示登录提示', async ({ page }) => {
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await expect(page.getByText('欢迎围观')).toBeVisible();
  await expect(page.getByText(/匿名只读/)).toBeVisible();
});
