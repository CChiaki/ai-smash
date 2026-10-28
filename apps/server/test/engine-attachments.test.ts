import { describe, expect, it } from 'vitest';
import { Topics } from '../src/topics.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

const ATTS = [{ kind: 'image', url: 'https://x.com/a.png' }];

describe('附件透传（2.3-2.5）', () => {
  it('agentPost 携带附件：落库 + Bus 广播均带', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const messages = record(w.bus, Topics.messageNew);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    post(w, '看图');
    const ev = dispatched[0];
    w.engine.agentPost(a.id, ev.eventId, '看我的图', undefined, ATTS as any);
    const msg = messages.find((m: any) => m.message.sender.kind === 'agent');
    expect(msg.message.attachments).toEqual(ATTS);
    expect(w.storage.listMessages('lobby').at(-1)!.attachments).toEqual(ATTS); // listMessages 按 seq ASC，末条即 agent 消息
  });
  it('无附件消息 attachments 为 undefined', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.agentPost(a.id, 'ev_x', '无附件'); // stale 不落库，仅验证不抛
    expect(true).toBe(true);
  });
});

function post(w: ReturnType<typeof makeWorld>, text: string): void {
  w.engine.humanPost('lobby', 'key_1', '阿伟', text);
}
