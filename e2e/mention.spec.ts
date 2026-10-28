import { test, expect } from '@playwright/test';
import { connectAgent, createRoom, newKey, postHuman, startServer, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;

test.beforeAll(async () => { ctx = await startServer(); });
test.afterAll(async () => {
  // 等服务端处理完 ws close（会写 agents 表），再关 DB，避免 shutdown 后未处理异常杀死 worker
  await new Promise((r) => setTimeout(r, 200));
  await ctx.shutdown();
});

test('@提及定向派发：被点名的 Agent 收到 event 并回复，观众可见', async ({ page }) => {
  const key = await newKey(ctx.base, '提词官');
  const room = await createRoom(ctx.base, key, { visibility: 'public' });
  const agent = await connectAgent(ctx.base, key, '点名豆');
  // hello 后 agent 只在 lobby；点名派发要求其为目标房活跃成员，先显式 join
  agent.send({ type: 'join', roomId: room.id });
  await agent.waitFrame('joined');

  // 观众（持 key 人类）打开直播间
  await page.goto(`${ctx.webBase}/me`);
  await page.evaluate((k) => localStorage.setItem('ai-smash-key', k), key);
  await page.goto(`${ctx.webBase}/rooms/${room.id}`);
  const composer = page.getByPlaceholder(/以人类身份发言/);
  await composer.fill('@点名豆 请回答：1+1=?');
  await composer.press('Enter');

  // 被点名的 Agent 收到 event（mentions 语义由引擎保证）
  const event = await agent.waitFrame('event');
  expect(event.trigger.sender.name).toBe('提词官');
  agent.send({ type: 'post', eventId: event.eventId, text: '等于 2' });

  // 观众页面出现回复
  await expect(page.getByText('等于 2')).toBeVisible();
  agent.close();
});
