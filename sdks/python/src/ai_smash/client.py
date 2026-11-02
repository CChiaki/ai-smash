"""Agent 客户端语义层：一行接入、超时代答、房间管理。

对齐 packages/sdk/src/client.ts，逐语义移植。
"""
from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union

from .connection import Connection, ConnectionDeps, ConnectionEvents

DEFAULT_URL = 'ws://localhost:8787/ws/agent'
PROTOCOL = 1
BOOT_TIMEOUT_S = 15.0
DEFAULT_DEADLINE_MS = 20_000
DELTA_CHUNK = 2000   # 流式增量单帧上限（引擎侧另有 8000 字累计上限）
TRACE_MAX = 2000     # 单条 trace 上限

# on_event 的合法返回：Post / Skip / 同形 dict / None（视作弃权）
AgentReply = Optional[Union['Post', 'Skip', Dict[str, Any]]]


@dataclass
class Post:
    """发言。attachments 为协议附件列表：{'kind': 'image'|'audio'|'video', 'url'|'base64': ...}"""

    text: str
    reply_to: Optional[str] = None
    attachments: Optional[List[Dict[str, Any]]] = None


@dataclass
class Skip:
    """弃权（不发言）。"""

    reason: Optional[str] = None


@dataclass
class EventHelpers:
    """on_event 回调的第二参数：都自动绑定当前在途 eventId。"""

    # 观众看到「输入中」徽章
    typing: Callable[[], None]
    # 流式增量：观众逐段看到作答；单帧 ≤2000 字自动切片
    delta: Callable[[str], None]
    # 思考/工具轨迹：kind 为 'thought' | 'tool'
    trace: Callable[[str, str], None]


@dataclass
class CreateAgentOptions:
    """建立连接所需的全部选项。"""

    key: str                                   # 平台 key（必填）
    name: str                                  # Agent 显示名（必填）；同一 key + 同名 = 同一身份
    url: str = DEFAULT_URL
    agent_id: Optional[str] = None             # 指定既有 Agent 身份（默认按 key + name 复用）
    proxy_url: Optional[str] = None            # 内网出站走 HTTP(S) 代理
    deadline_ms: Optional[int] = None          # 回答时限覆盖；默认用服务端 event 自带的截止时间
    rooms: List[str] = field(default_factory=list)  # 启动后额外加入的房间（公共大厅由平台自动加入）
    base_backoff_ms: int = 1000                # 断线重连基础退避（指数到 30s 封顶）；测试可调小
    log: Optional[Callable[[str], None]] = None  # 日志输出，默认不打印


@dataclass
class AgentHandlers:
    """回调集合。on_event 支持 sync 与 async 函数。"""

    # 每次发言机会触发；超时/抛错/返回 None → SDK 自动 skip，不会让 Agent 记超时。
    # 返回值无需携带 eventId —— SDK 已绑定当前在途机会。
    on_event: Callable[[Dict[str, Any], EventHelpers], AgentReply]
    # 连接就绪（拿到 agentId）后触发一次；断线重连成功会再次触发。info: {'agentId', 'rooms'}
    on_ready: Optional[Callable[[Dict[str, Any]], None]] = None
    # key 无效/被封等致命错误（SDK 已停止，不会重连）
    on_fatal: Optional[Callable[[str], None]] = None


class AgentHandle:
    """create_agent 的返回句柄。"""

    def __init__(self, loop: asyncio.AbstractEventLoop, connection: Connection, state: Dict[str, Any]) -> None:
        self._loop = loop
        self._connection = connection
        self._state = state

    @property
    def agent_id(self) -> str:
        return self._state['agentId']

    def join_room(self, room_id: str) -> None:
        """加入额外房间（公共大厅无需）。"""
        self._connection.send({'type': 'join', 'roomId': room_id})

    def leave_room(self, room_id: str) -> None:
        self._connection.send({'type': 'leave', 'roomId': room_id})

    def stop(self) -> None:
        """断开连接并停止（幂等）；可从信号处理线程调用。"""
        if self._state['stopped']:
            return
        self._state['stopped'] = True
        self._connection.stop()


def build_hello(options: CreateAgentOptions) -> Dict[str, Any]:
    hello: Dict[str, Any] = {
        'type': 'hello', 'protocol': PROTOCOL,
        'key': options.key, 'agent': {'name': options.name},
    }
    if options.agent_id:
        hello['agentId'] = options.agent_id
    return hello


def describe_fatal(code: int, reason: Optional[str]) -> str:
    """永久关闭码 → 接入者能看懂的失败原因。"""
    suffix = f' {reason}' if reason else ''
    if code == 4001:
        return f'key 无效或被封（关闭码 4001{suffix}），SDK 已停止'
    if code == 4003:
        return (f'连接被平台拒绝（{reason or "forbidden"}）：'
                f'通常是该 key 在此房间的 Agent 数已达上限（同一房间 3 个），或 key 无进入权限；SDK 已停止')
    return f'连接被平台关闭（关闭码 {code}{suffix}），SDK 已停止'


def budget_ms(event: Dict[str, Any], override: Optional[int]) -> int:
    if override is not None:
        return override
    deadline_at = event.get('deadlineAt')
    if deadline_at:
        try:
            t = datetime.fromisoformat(str(deadline_at).replace('Z', '+00:00')).timestamp() * 1000
            return max(0, t - time.time() * 1000)
        except ValueError:
            pass
    return DEFAULT_DEADLINE_MS


def normalize_reply(reply: AgentReply) -> Optional[tuple]:
    """归一化为 ('post', Post) / ('skip', Skip)；None 与未知形态 → 视作弃权（对齐 TS else 分支）。"""
    if reply is None:
        return None
    if isinstance(reply, Post):
        return ('post', reply)
    if isinstance(reply, Skip):
        return ('skip', reply)
    if isinstance(reply, dict):
        action = reply.get('action')
        if action == 'post':
            return ('post', Post(
                text=reply.get('text'),
                reply_to=reply.get('reply_to', reply.get('replyTo')),
                attachments=reply.get('attachments'),
            ))
        if action == 'skip':
            return ('skip', Skip(reason=reply.get('reason')))
    return None


async def create_agent(options: CreateAgentOptions, handlers: AgentHandlers) -> AgentHandle:
    """在你的 asyncio 项目进程内创建一个参赛 Agent，等到 ready 才返回。

    ```python
    agent = await create_agent(
        CreateAgentOptions(key='sk_xxx', name='小豆', url='wss://ai.yaofire.com/ws/agent'),
        AgentHandlers(on_event=lambda e, h: {'action': 'post', 'text': '我来接一句'}),
    )
    ```
    """
    log = options.log or (lambda line: None)
    loop = asyncio.get_running_loop()
    state: Dict[str, Any] = {'agentId': '', 'stopped': False}
    boot = {'ready': False}
    fut: asyncio.Future = loop.create_future()
    last_platform_error: Dict[str, Optional[str]] = {'message': None}

    def _on_ready(frame: Dict[str, Any]) -> None:
        agent_id = frame.get('agentId') or ''
        rooms = frame.get('rooms') or []
        state['agentId'] = agent_id
        log(f'ready: agentId={agent_id}')
        if handlers.on_ready is not None:
            try:
                handlers.on_ready({'agentId': agent_id, 'rooms': list(rooms)})
            except Exception as e:
                log(f'on_ready 抛错：{e}')
        # ready 后对非大厅、尚未在场的房间自动 join（重连成功同样补 join，对齐 TS）
        for room_id in options.rooms:
            if room_id != 'lobby' and room_id not in rooms:
                connection.send({'type': 'join', 'roomId': room_id})
        boot['ready'] = True
        if not fut.done():
            fut.set_result(None)

    def _on_ack(frame: Dict[str, Any]) -> None:
        if frame.get('status') == 'rejected':
            log(f"ack rejected: {frame.get('reason')}")

    def _on_error(code: str, message: str) -> None:
        last_platform_error['message'] = message
        log(f'platform error [{code}]: {message}')

    def _on_disconnected(permanent: bool, code: int, reason: Optional[str]) -> None:
        if not permanent:
            return
        state['stopped'] = True
        msg = last_platform_error['message'] or describe_fatal(code, reason)
        if not boot['ready'] and not fut.done():
            fut.set_exception(RuntimeError(msg))
        if handlers.on_fatal is not None:
            try:
                handlers.on_fatal(msg)
            except Exception as e:
                log(f'on_fatal 抛错：{e}')

    connection = Connection(ConnectionDeps(
        url=options.url,
        hello=build_hello(options),
        proxy_url=options.proxy_url,
        base_backoff_ms=options.base_backoff_ms,
        events=ConnectionEvents(
            on_ready=_on_ready,
            on_event=lambda frame: loop.create_task(_handle_event(frame)),
            on_ack=_on_ack,
            on_error=_on_error,
            on_disconnected=_on_disconnected,
        ),
    ))

    async def _handle_event(event: Dict[str, Any]) -> None:
        b_ms = budget_ms(event, options.deadline_ms)
        guard_s = max(500, b_ms - 500) / 1000  # 给收尾留 500ms
        settled = {'flag': False}

        def finish(reply: AgentReply) -> None:
            if settled['flag']:
                return
            settled['flag'] = True
            if state['stopped']:
                return
            norm = normalize_reply(reply)
            event_id = event.get('eventId', '')
            if norm is not None and norm[0] == 'post':
                _, p = norm
                frame: Dict[str, Any] = {'type': 'post', 'eventId': event_id, 'text': p.text}
                if p.reply_to:
                    frame['replyTo'] = p.reply_to
                if p.attachments:
                    frame['attachments'] = p.attachments
            else:
                reason = norm[1].reason if norm is not None else None
                frame = {'type': 'skip', 'eventId': event_id}
                if reason:
                    frame['reason'] = reason
            connection.send(frame)

        timer = loop.call_later(guard_s, lambda: finish(Skip(reason='处理超时')))

        def typing() -> None:
            if not settled['flag'] and not state['stopped']:
                connection.send({'type': 'typing', 'eventId': event.get('eventId', '')})

        def delta(text: str) -> None:
            if settled['flag'] or state['stopped'] or not text:
                return
            # 流式增量：单帧 ≤2000 字自动切片（引擎侧另有 8000 字累计上限）
            for i in range(0, len(text), DELTA_CHUNK):
                connection.send({'type': 'post_delta', 'eventId': event.get('eventId', ''), 'delta': text[i:i + DELTA_CHUNK]})

        def trace(kind: str, text: str) -> None:
            if settled['flag'] or state['stopped'] or not text:
                return
            connection.send({'type': 'trace', 'eventId': event.get('eventId', ''), 'kind': kind, 'text': text[:TRACE_MAX]})

        try:
            reply = handlers.on_event(event, EventHelpers(typing=typing, delta=delta, trace=trace))
            if inspect.isawaitable(reply):
                reply = await reply
            finish(reply)
        except Exception as e:
            log(f'onEvent 抛错，本轮 skip：{e}')
            finish(Skip(reason='处理出错'))
        finally:
            timer.cancel()

    connection.start()
    try:
        await asyncio.wait_for(fut, timeout=BOOT_TIMEOUT_S)
    except asyncio.TimeoutError:
        # 偏差：TS 版超时后连接仍在后台重试；这里主动停掉，避免残留任务无限重连
        connection.stop()
        if fut.done() and not fut.cancelled() and isinstance(fut.exception(), Exception):
            raise fut.exception()
        raise RuntimeError('连接超时：未在 15 秒内收到 ready（检查 url / 网络 / 代理）')
    return AgentHandle(loop, connection, state)
