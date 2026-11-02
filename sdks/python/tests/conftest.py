"""测试公共设施：进程内假 WS 平台（对齐 packages/sdk/test 的 startPlatform）。"""
from __future__ import annotations

import asyncio
import inspect
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from websockets.asyncio.server import ServerConnection, serve

READY_LIMITS = {'deadlineMs': 20000, 'contextBytes': 32768}

# on_hello(ws, received, frame) —— 收到 hello 时触发；可为 sync 或 async
OnHello = Callable[[ServerConnection, List[Dict[str, Any]], Dict[str, Any]], Any]


def ready_frame(agent_id: str = 'ag_1', rooms: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        'type': 'ready', 'agentId': agent_id,
        'rooms': rooms if rooms is not None else ['lobby'],
        'limits': dict(READY_LIMITS),
    }


def event_frame(event_id: str, deadline_seconds: float = 5) -> Dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=deadline_seconds)
    return {
        'type': 'event', 'eventId': event_id, 'roomId': 'lobby',
        'trigger': {'kind': 'message', 'messageId': 'm_1', 'sender': {'kind': 'human', 'name': '阿伟'}},
        'room': {'title': '公共大厅', 'topic': None},
        'context': {'messages': [{
            'id': 'm_1', 'roomId': 'lobby', 'seq': 1,
            'sender': {'kind': 'human', 'name': '阿伟'}, 'text': '来聊聊',
            'replyTo': None, 'createdAt': 't', 'deletedAt': None,
        }], 'truncated': False},
        'deadlineAt': deadline.isoformat(),
    }


class FakePlatform:
    def __init__(self, server: Any, url: str, received: List[Dict[str, Any]], clients: List[ServerConnection]) -> None:
        self.server = server
        self.url = url
        self.received = received
        self.clients = clients

    def last_client(self) -> ServerConnection:
        return self.clients[-1]

    async def close(self) -> None:
        self.server.close()
        await self.server.wait_closed()


async def start_platform(on_hello: Optional[OnHello] = None) -> FakePlatform:
    """起一个绑 127.0.0.1 随机端口的假平台；收到的每帧进 received，hello 时触发 on_hello。"""
    received: List[Dict[str, Any]] = []
    clients: List[ServerConnection] = []

    async def handler(ws: ServerConnection) -> None:
        clients.append(ws)
        try:
            async for raw in ws:
                frame = json.loads(raw)
                received.append(frame)
                if frame.get('type') == 'hello' and on_hello is not None:
                    result = on_hello(ws, received, frame)
                    if inspect.isawaitable(result):
                        await result
        except Exception:
            pass  # abort / 关闭竞态引起的收尾异常忽略

    server = await serve(handler, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    return FakePlatform(server, f'ws://127.0.0.1:{port}/ws/agent', received, clients)


async def wait_until(fn: Callable[[], bool], timeout_s: float = 3.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if fn():
            return
        await asyncio.sleep(0.01)
    assert fn(), '条件未在时限内满足'


async def send_ready(ws: ServerConnection, agent_id: str = 'ag_1', rooms: Optional[List[str]] = None) -> None:
    await ws.send(json.dumps(ready_frame(agent_id, rooms)))
