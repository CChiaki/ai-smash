import { expect, test } from '@playwright/test';
import { connectAgent, createRoom, newKey, startServer, type AgentClient, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;
let roomId: string;
let rawKey: string;
let agent: AgentClient;

test.beforeAll(async () => {
  ctx = await startServer();
  rawKey = await newKey(ctx.base, '玩家甲');
  const room = await createRoom(ctx.base, rawKey, { title: '发言链路房' });
  roomId = room.id;
  const agentKey = await newKey(ctx.base, 'agent 菊');
  agent = await connectAgent(ctx.base, agentKey, '回声侠');
  // hello 后服务端只把 agent 加入 lobby；需显式 join 测试房才能收到该房 event
  const known = agent.frames.length;
  agent.send({ type: 'join', roomId });
  while (!agent.frames.slice(known).some((f) => f.type === 'joined' && f.roomId === roomId)) {
    await new Promise((r) => setTimeout(r, 50));
  }
});

test.afterAll(async () => {
  agent?.close();
  // 等服务端处理完 ws close（会写 agents 表），再关 DB，避免 shutdown 后未处理异常杀死 worker
  await new Promise((r) => setTimeout(r, 200));
  await ctx.shutdown();
});

test('key 登录 → 发言 → agent 收到并回复 → 双方可见', async ({ page }) => {
  await page.goto(`${ctx.webBase}/me`);
  await page.evaluate((k) => localStorage.setItem('ai-smash-key', k), rawKey);
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await page.getByPlaceholder('以人类身份发言…').fill('agent 你好');
  await page.getByText('发送').click();
  // agent 侧收到 event 并回复
  const event = await agent.waitFrame('event');
  expect(event.context.messages.at(-1).text).toBe('agent 你好');
  agent.send({ type: 'post', eventId: event.eventId, text: '人类你好，我是回声侠' });
  // 观众页两侧消息都可见
  await expect(page.getByText('agent 你好')).toBeVisible();
  await expect(page.getByText('人类你好，我是回声侠')).toBeVisible();
});

test('给 agent 消息点赞后赞数出现', async ({ page }) => {
  // 每个用例都是全新 page context：先重新写入 key 再进房，才有点赞资格
  await page.goto(`${ctx.webBase}/me`);
  await page.evaluate((k) => localStorage.setItem('ai-smash-key', k), rawKey);
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await page.getByTitle('点赞').first().click();
  // v2 点赞按钮为「♡ n」（emoji 已随设计系统移除）
  await expect(page.getByText(/♡ \d+/).first()).toBeVisible();
});
