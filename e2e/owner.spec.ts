import { expect, test } from '@playwright/test';
import { connectAgent, createRoom, newKey, startServer, type AgentClient, type ServerCtx } from './helpers.js';

let ctx: ServerCtx;
let roomId: string;
let ownerKey: string;
let agent: AgentClient;

test.beforeAll(async () => {
  ctx = await startServer();
  ownerKey = await newKey(ctx.base, '房主');
  const room = await createRoom(ctx.base, ownerKey, { title: '房主控制房' });
  roomId = room.id;
  const agentKey = await newKey(ctx.base);
  agent = await connectAgent(ctx.base, agentKey, '受控豆');
  // hello 后服务端只把 agent 加入 lobby；显式 join 测试房，并从 frames 快照切片等“新”的 joined 帧
  //（不能直接 waitFrame('joined')，会误命中 lobby 的旧帧）
  const known = agent.frames.length;
  agent.send({ type: 'join', roomId });
  while (!agent.frames.slice(known).some((f) => f.type === 'joined' && f.roomId === roomId)) {
    await new Promise((r) => setTimeout(r, 50));
  }
});

test.afterAll(async () => {
  agent?.close();
  // 等服务端处理完 ws close（会写 agents 表），再关 DB
  await new Promise((r) => setTimeout(r, 200));
  await ctx.shutdown();
});

test('房主暂停后按钮变恢复，agent 不再收到 event', async ({ page }) => {
  await page.goto(`${ctx.webBase}/me`);
  await page.evaluate((k) => localStorage.setItem('ai-smash-key', k), ownerKey);
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  await expect(page.getByText('邀请码')).toBeHidden(); // 公开房无邀请码
  await page.getByText('暂停', { exact: true }).click();
  await expect(page.getByText('恢复', { exact: true })).toBeVisible();
  // 等 WS 房间帧确认 status=paused 已生效，避免投喂消息赶在暂停前入库
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  const postRes = await fetch(`${ctx.base}/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ text: '暂停期间投喂' }),
  });
  expect(postRes.status).toBe(201);
  await page.waitForTimeout(1500);
  expect(
    agent.frames.find((x) => x.type === 'event' && x.context.messages.at(-1)?.text === '暂停期间投喂'),
  ).toBeUndefined();
  await page.getByText('恢复', { exact: true }).click();
});

test('房主踢出 agent：presence 消失且 agent 收到 state.kicked', async ({ page }) => {
  // 每个用例都是全新 page context：重新写入房主 key 并进房
  await page.goto(`${ctx.webBase}/me`);
  await page.evaluate((k) => localStorage.setItem('ai-smash-key', k), ownerKey);
  await page.goto(`${ctx.webBase}/rooms/${roomId}`);
  // 不能直接 waitFrame('state')：上一用例的暂停/恢复已推过 state 帧（roomStatus），
  // 会误命中旧帧。与 beforeAll 相同，用 frames 快照切片等「新」的 state.kicked 帧。
  const known = agent.frames.length;
  await page.getByText('踢出').click();
  await expect(page.getByText('受控豆')).toBeHidden();
  await expect.poll(async () =>
    agent.frames.slice(known).some((f) => f.type === 'state' && f.kicked === true),
  ).toBe(true);
});
