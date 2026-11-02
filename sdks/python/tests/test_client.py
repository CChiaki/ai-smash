"""create_agent 语义测试（对齐 packages/sdk/test/client.test.ts）。"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List

from ai_smash import AgentHandlers, CreateAgentOptions, Post, Skip, create_agent

from conftest import event_frame, ready_frame, send_ready, start_platform, wait_until


def test_boot_rejected_4003_fast():
    """error 帧 + 4003 关闭：立即以平台原因抛错，不等 15s 超时。"""
    async def on_hello(ws, received, frame):
        await ws.send(json.dumps({'type': 'error', 'code': 'forbidden',
                                  'message': '该 key 在此房间的 Agent 数已达上限'}))
        await ws.close(4003, 'forbidden')

    async def scenario():
        platform = await start_platform(on_hello)
        t0 = time.monotonic()
        try:
            await create_agent(
                CreateAgentOptions(key='sk_x', name='超额豆', url=platform.url),
                AgentHandlers(on_event=lambda e, h: None),
            )
            raise AssertionError('应当抛错')
        except RuntimeError as e:
            assert 'Agent 数已达上限' in str(e)
            assert time.monotonic() - t0 < 5  # 远小于 15s 超时
        finally:
            await platform.close()

    asyncio.run(scenario())


def test_hello_ready_onready_and_post():
    """hello → ready → onReady；event → typing + post（自动绑定 eventId 与 replyTo）。"""
    async def on_hello(ws, received, frame):
        assert frame['type'] == 'hello' and frame['protocol'] == 1
        assert frame['agent'] == {'name': '小豆'}
        await send_ready(ws, 'ag_1')

    async def scenario():
        platform = await start_platform(on_hello)
        seen: List[Any] = []

        def on_event(e, h):
            h.typing()
            return {'action': 'post', 'text': '我来说两句', 'reply_to': e['trigger']['messageId']}

        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='小豆', url=platform.url),
            AgentHandlers(on_event=on_event, on_ready=lambda info: seen.append(('ready', info['agentId']))),
        )
        assert agent.agent_id == 'ag_1'
        await wait_until(lambda: any(s[0] == 'ready' for s in seen))
        await platform.last_client().send(json.dumps(event_frame('ev_1')))
        await wait_until(lambda: any(f['type'] == 'post' for f in platform.received))
        typing = next(f for f in platform.received if f['type'] == 'typing')
        post = next(f for f in platform.received if f['type'] == 'post')
        assert typing['eventId'] == 'ev_1'
        assert post == {'type': 'post', 'eventId': 'ev_1', 'text': '我来说两句', 'replyTo': 'm_1'}
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_on_event_timeout_auto_skip():
    """onEvent 超时 → SDK 代发 skip，不记超时。"""
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_slow'))

        async def never(e, h):
            await asyncio.Event().wait()  # 永不返回

        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='慢豆', url=platform.url, deadline_ms=400),
            AgentHandlers(on_event=never),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_2', 5)))
        await wait_until(lambda: any(f['type'] == 'skip' for f in platform.received))
        skip = next(f for f in platform.received if f['type'] == 'skip')
        assert skip['eventId'] == 'ev_2' and skip['reason'] == '处理超时'
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_error_skip_none_and_fatal_4001():
    """onEvent 抛错 → skip；返回 None → skip；4001 → onFatal 且 stop 幂等。"""
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_9'))
        fatal: List[str] = []

        async def boom(e, h):
            raise RuntimeError('LLM 炸了')

        agent = await create_agent(
            CreateAgentOptions(key='sk_bad', name='背时豆', url=platform.url),
            AgentHandlers(on_event=boom, on_fatal=lambda r: fatal.append(r)),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_3', 5)))
        await wait_until(lambda: any(f['type'] == 'skip' and f.get('reason') == '处理出错'
                                     for f in platform.received))
        skip = next(f for f in platform.received if f['type'] == 'skip')
        assert skip['eventId'] == 'ev_3'
        # 4001 → 永久 fatal，on_fatal 收到含关闭码的人话原因
        await platform.last_client().close(4001, 'invalid_key')
        await wait_until(lambda: len(fatal) > 0)
        assert '4001' in fatal[0]
        agent.stop()
        agent.stop()  # 幂等
        await platform.close()

    asyncio.run(scenario())


def test_none_reply_is_skip_without_reason():
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_n'))
        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='沉默豆', url=platform.url),
            AgentHandlers(on_event=lambda e, h: None),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_n', 5)))
        await wait_until(lambda: any(f['type'] == 'skip' for f in platform.received))
        skip = next(f for f in platform.received if f['type'] == 'skip')
        assert skip == {'type': 'skip', 'eventId': 'ev_n'}  # 无 reason 键
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_rooms_auto_join_and_join_room():
    """rooms：ready 后对非大厅房间自动 join；handle.join_room 可再加。"""
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_2', ['lobby']))
        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='串场豆', url=platform.url, rooms=['rm_a', 'lobby']),
            AgentHandlers(on_event=lambda e, h: None),
        )
        await wait_until(lambda: any(f['type'] == 'join' and f['roomId'] == 'rm_a'
                                     for f in platform.received))
        joins = [f for f in platform.received if f['type'] == 'join']
        assert len(joins) == 1  # lobby 不重复 join
        agent.join_room('rm_b')
        await wait_until(lambda: any(f['type'] == 'join' and f['roomId'] == 'rm_b'
                                     for f in platform.received))
        agent.leave_room('rm_a')
        await wait_until(lambda: any(f['type'] == 'leave' for f in platform.received))
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_delta_segments_then_post():
    """helpers.delta 逐段发送 post_delta（Post 数据类返回）。"""
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_d'))

        def on_event(e, h):
            h.typing()
            h.delta('第一段')
            h.delta('第二段')
            return Post(text='第一段第二段')

        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='流式豆', url=platform.url),
            AgentHandlers(on_event=on_event),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_4')))
        await wait_until(lambda: any(f['type'] == 'post' for f in platform.received), 3)
        deltas = [f for f in platform.received if f['type'] == 'post_delta']
        post = next(f for f in platform.received if f['type'] == 'post')
        assert [f['delta'] for f in deltas] == ['第一段', '第二段']
        assert all(f['eventId'] == post['eventId'] for f in deltas)
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_delta_slice_2000():
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_l'))

        def on_event(e, h):
            h.delta('x' * 4500)
            return {'action': 'post', 'text': 'x' * 4500}

        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='长文豆', url=platform.url),
            AgentHandlers(on_event=on_event),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_5')))
        await wait_until(lambda: any(f['type'] == 'post' for f in platform.received), 3)
        deltas = [f for f in platform.received if f['type'] == 'post_delta']
        assert len(deltas) == 3  # 2000 + 2000 + 500
        assert all(len(f['delta']) <= 2000 for f in deltas)
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_trace_report_and_silent_after_settled():
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_t'))
        late: Dict[str, Any] = {}

        def on_event(e, h):
            h.trace('thought', '先想')
            h.trace('tool', 'x' * 2500)
            h.trace('tool', '')  # 空串静默
            late['h'] = h
            return {'action': 'post', 'text': '答案'}

        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='思考豆', url=platform.url),
            AgentHandlers(on_event=on_event),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_t')))
        await wait_until(lambda: any(f['type'] == 'post' for f in platform.received))
        traces = [f for f in platform.received if f['type'] == 'trace']
        assert traces[0]['eventId'] == 'ev_t' and traces[0]['kind'] == 'thought' and traces[0]['text'] == '先想'
        assert len(traces[1]['text']) == 2000  # 截断
        late['h'].trace('thought', '晚到的想法')  # settled 后静默
        await asyncio.sleep(0.05)
        assert len([f for f in platform.received if f['type'] == 'trace']) == 2
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_post_with_attachments():
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_a'))
        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='画图豆', url=platform.url),
            AgentHandlers(on_event=lambda e, h: {
                'action': 'post', 'text': '看图',
                'attachments': [{'kind': 'image', 'url': 'https://x.com/a.png'}],
            }),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_a')))
        await wait_until(lambda: any(f['type'] == 'post' and 'attachments' in f
                                     for f in platform.received))
        post = next(f for f in platform.received if f['type'] == 'post')
        assert post['attachments'] == [{'kind': 'image', 'url': 'https://x.com/a.png'}]
        agent.stop()
        await platform.close()

    asyncio.run(scenario())


def test_skip_dataclass_return():
    """Skip 数据类返回 → skip 帧携带 reason。"""
    async def scenario():
        platform = await start_platform(lambda ws, r, f: send_ready(ws, 'ag_s'))
        agent = await create_agent(
            CreateAgentOptions(key='sk_x', name='谦虚豆', url=platform.url),
            AgentHandlers(on_event=lambda e, h: Skip(reason='没话说')),
        )
        await platform.last_client().send(json.dumps(event_frame('ev_s', 5)))
        await wait_until(lambda: any(f['type'] == 'skip' for f in platform.received))
        skip = next(f for f in platform.received if f['type'] == 'skip')
        assert skip == {'type': 'skip', 'eventId': 'ev_s', 'reason': '没话说'}
        agent.stop()
        await platform.close()

    asyncio.run(scenario())
