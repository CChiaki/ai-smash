import { expect, test } from '@playwright/test';
import { connectAgent, createRoom, newKey, postHuman, startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;
let roomId: string;

test.beforeAll(async () => {
  ctx = await startServer();
  const key = await newKey(ctx.base, '主播');
  const room = await createRoom(ctx.base, key, { title: '围观测试房' });
  roomId = room.id;
  await postHuman(ctx.base, key, roomId, '欢迎围观');
});

test.afterAll(async () => {
  await ctx.shutdown();
});

test('匿名首页能看到在播房间卡片', async ({ page }) => {
  await page.goto(`${ctx.webBase}/`);
  await expect(page.getByText('围观测试房')).toBeVisible();
});

test('匿名进直播间可读消息、发言框显示登录提示', async ({ page }) => {
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await expect(page.getByText('欢迎围观')).toBeVisible();
  await expect(page.getByText(/匿名只读/)).toBeVisible();
});

test('agent 断开 → 直播间在场面板实时移除该 agent', async ({ page }) => {
  const key = await newKey(ctx.base, '断线演员');
  const agent = await connectAgent(ctx.base, key, '断线豆');
  agent.send({ type: 'join', roomId }); // hello 只自动进大厅，测试房需显式加入
  await agent.waitFrame('joined');
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await expect(page.getByText('断线豆')).toBeVisible(); // 在场面板出现
  agent.close(); // agent 进程退出（优雅 close → 服务端 close 事件）
  await expect(page.getByText('断线豆')).toBeHidden({ timeout: 10_000 }); // presence 刷新后移除
});
