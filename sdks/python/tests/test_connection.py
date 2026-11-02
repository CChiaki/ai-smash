"""Connection 层测试（对齐 packages/sdk/test/connection.test.ts）。"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List

from ai_smash import Connection, ConnectionDeps, ConnectionEvents

from conftest import event_frame, start_platform, wait_until


def make_connection(url: str, events: ConnectionEvents, base_backoff_ms: int = 1000) -> Connection:
    conn = Connection(ConnectionDeps(
        url=url,
        hello={'type': 'hello', 'protocol': 1, 'key': 'sk_x', 'agent': {'name': '小豆'}},
        events=events,
        base_backoff_ms=base_backoff_ms,
    ))
    conn.start()
    return conn


def test_hello_first_and_frames_dispatch():
    async def on_hello(ws, received, frame):
        await ws.send(json.dumps({'type': 'ready', 'agentId': 'ag_1', 'rooms': [],
                                  'limits': {'deadlineMs': 20000, 'contextBytes': 100}}))

    async def scenario():
        platform = await start_platform(on_hello)
        got: List[Dict[str, Any]] = []

        def on_ready(frame):
            got.append({'kind': 'ready', 'f': frame})

        def on_event(frame):
            got.append({'kind': 'event', 'f': frame})

        def on_ack(frame):
            got.append({'kind': 'ack', 'f': frame})

        def on_disconnected(permanent, code, reason):
            got.append({'kind': 'disconnected', 'permanent': permanent, 'code': code})

        conn = make_connection(platform.url, ConnectionEvents(
            on_ready=on_ready, on_event=on_event, on_ack=on_ack, on_disconnected=on_disconnected,
        ))
        await wait_until(lambda: len(platform.received) > 0)
        assert platform.received[0]['type'] == 'hello'
        await wait_until(lambda: any(g['kind'] == 'ready' for g in got))
        await asyncio.sleep(0.05)
        await platform.last_client().send(json.dumps(event_frame('ev_1')))
        await platform.last_client().send(json.dumps({'type': 'ack', 'eventId': 'ev_1', 'status': 'posted'}))
        await asyncio.sleep(0.05)
        assert [g['kind'] for g in got] == ['ready', 'event', 'ack']
        conn.stop()
        await platform.close()

    asyncio.run(scenario())


def test_send_open_forwards_and_silent_after_stop():
    async def on_hello(ws, received, frame):
        await ws.send(json.dumps({'type': 'ready', 'agentId': 'ag_1', 'rooms': [],
                                  'limits': {'deadlineMs': 1, 'contextBytes': 1}}))

    async def scenario():
        platform = await start_platform(on_hello)
        conn = make_connection(platform.url, ConnectionEvents(
            on_ready=lambda f: None, on_event=lambda f: None,
            on_ack=lambda f: None, on_disconnected=lambda *a: None,
        ))
        # ready 是服务端→客户端方向，不在 platform.received 里，等握手完成即可
        await asyncio.sleep(0.05)
        conn.send({'type': 'post', 'eventId': 'ev_1', 'text': 'hi'})
        await wait_until(lambda: any(f['type'] == 'post' for f in platform.received))
        conn.stop()
        conn.send({'type': 'post', 'eventId': 'ev_2', 'text': 'closed'})  # 不抛错即可
        await platform.close()

    asyncio.run(scenario())


def test_reconnect_on_abnormal_drop_and_stop_on_4001():
    async def on_hello(ws, received, frame):
        drops[0] += 1
        if drops[0] == 1:
            ws.transport.abort()  # 异常断开：客户端侧表现为 1006
        else:
            await ws.close(4001, 'invalid_key')

    drops = [0]

    async def scenario():
        platform = await start_platform(on_hello)
        disconnects: List[Dict[str, Any]] = []
        conn = make_connection(platform.url, ConnectionEvents(
            on_ready=lambda f: None, on_event=lambda f: None, on_ack=lambda f: None,
            on_disconnected=lambda permanent, code, reason: disconnects.append(
                {'permanent': permanent, 'code': code}),
        ), base_backoff_ms=10)
        await wait_until(lambda: len(disconnects) >= 2)
        assert disconnects[0] == {'permanent': False, 'code': 1006}
        assert disconnects[1] == {'permanent': True, 'code': 4001}
        count = drops[0]
        await asyncio.sleep(0.15)
        assert drops[0] == count  # 4001 后不再重连
        conn.stop()
        await platform.close()

    asyncio.run(scenario())
