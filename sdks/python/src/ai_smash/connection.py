"""WS 连接层：握手、帧分发、指数退避重连。

对齐 packages/sdk/src/connection.ts，逐语义移植：
- open 后自动发 hello；ready/event/ack/error 分发回调；pong 与未知帧忽略；非法 JSON 静默丢弃
- close code 4001/4003 → 永久断开不重连；其余按指数退避重连（base 起，×2，30s 封顶）
- 退避在收到 ready 帧时重置（不是在建连时）
- stop() 之后的关闭事件被吞掉：不回调 on_disconnected、不重连
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, WebSocketException

# 单帧接收上限：容纳服务端 event 大上下文（协议侧 agent 帧上限 3MB，接收侧放宽到 4MB）
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_BACKOFF_MS = 30_000
# 4001 = key 无效/被封；4003 = 引擎语义拒绝（房间配额满/无权限/被踢）——重连也不会成功
PERMANENT_CLOSE_CODES = (4001, 4003)


@dataclass
class ConnectionEvents:
    """Connection 的回调集合；任一回调抛错都不会击穿连接循环。"""

    on_ready: Callable[[Dict[str, Any]], None]
    on_event: Callable[[Dict[str, Any]], None]
    on_ack: Callable[[Dict[str, Any]], None]
    # (permanent, close_code, close_reason)
    on_disconnected: Callable[[bool, int, Optional[str]], None]
    # 平台下发的 error 帧（如加入被拒的明确原因）；多在关闭前到达
    on_error: Optional[Callable[[str, str], None]] = None


@dataclass
class ConnectionDeps:
    url: str
    hello: Dict[str, Any]
    events: ConnectionEvents
    base_backoff_ms: int = 1000
    # 内网出站走 HTTP(S) 代理（规格 16.2）；None = 直连（忽略环境变量代理，与 TS 版一致）
    proxy_url: Optional[str] = None


class Connection:
    def __init__(self, deps: ConnectionDeps) -> None:
        self._deps = deps
        self._ws: Any = None
        self._stopped = False
        self._backoff_ms = deps.base_backoff_ms
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._task: Optional[asyncio.Task] = None
        self._send_tasks: set = set()

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._task = self._loop.create_task(self._run())

    def stop(self) -> None:
        """停止并关闭（幂等）；可从任意线程调用。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            self._stopped = True
            return
        try:
            loop.call_soon_threadsafe(self._do_stop)
        except RuntimeError:
            self._stopped = True  # 事件循环已死，兜底置位

    def _do_stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        ws = self._ws
        if ws is not None:
            self._loop.create_task(self._close_quietly(ws))

    @staticmethod
    async def _close_quietly(ws: Any) -> None:
        try:
            await ws.close(code=1000, reason='bridge_shutdown')
        except Exception:
            pass  # 已关闭则忽略

    def send(self, frame: Dict[str, Any]) -> None:
        """发一帧；非 OPEN 时静默丢弃。可从任意线程调用。"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            task = loop.call_soon_threadsafe(self._spawn_send, frame)
        except RuntimeError:
            pass

    def _spawn_send(self, frame: Dict[str, Any]) -> None:
        task = asyncio.get_running_loop().create_task(self._send(frame))
        self._send_tasks.add(task)
        task.add_done_callback(self._send_tasks.discard)

    async def _send(self, frame: Dict[str, Any]) -> None:
        # 读最新 ws：重连后 send 打到新连接（与 TS 行为一致）
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(frame, ensure_ascii=False))
        except Exception:
            pass  # 关闭竞态：静默

    async def _run(self) -> None:
        deps = self._deps
        while not self._stopped:
            code, reason = 1006, None
            try:
                async with ws_connect(
                    deps.url,
                    proxy=deps.proxy_url,  # None = 直连
                    max_size=MAX_FRAME_BYTES,
                ) as ws:
                    self._ws = ws
                    await ws.send(json.dumps(deps.hello, ensure_ascii=False))
                    async for raw in ws:
                        self._dispatch(raw)
            except ConnectionClosed as e:
                code, reason = self._close_of(e)
            except (WebSocketException, OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
                code, reason = 1006, None  # 连接建立失败 / 异常断开（TS 侧表现为 close 1006）
            self._ws = None
            if self._stopped:
                return  # stop 之后的关闭事件被吞掉（对齐 TS）
            permanent = code in PERMANENT_CLOSE_CODES
            self._safe(lambda: deps.events.on_disconnected(permanent, code, reason))
            if permanent:
                return  # 不重试，由上层退出
            delay_s = self._backoff_ms / 1000
            self._backoff_ms = min(self._backoff_ms * 2, MAX_BACKOFF_MS)
            await asyncio.sleep(delay_s)

    @staticmethod
    def _close_of(e: ConnectionClosed) -> Tuple[int, Optional[str]]:
        if e.rcvd is not None:
            return e.rcvd.code, (e.rcvd.reason or None)
        if e.sent is not None:
            return e.sent.code, (e.sent.reason or None)
        return 1006, None  # 无关闭帧 = 异常断开

    def _dispatch(self, raw: Any) -> None:
        try:
            frame = json.loads(raw if isinstance(raw, str) else raw.decode('utf-8'))
        except Exception:
            return  # 非法 JSON 静默丢弃
        if not isinstance(frame, dict):
            return
        events = self._deps.events
        ftype = frame.get('type')
        if ftype == 'ready':
            self._backoff_ms = self._deps.base_backoff_ms  # ready 重置退避（对齐 TS）
            self._safe(lambda: events.on_ready(frame))
        elif ftype == 'event':
            self._safe(lambda: events.on_event(frame))
        elif ftype == 'ack':
            self._safe(lambda: events.on_ack(frame))
        elif ftype == 'error':
            if events.on_error is not None:
                self._safe(lambda: events.on_error(str(frame.get('code', '')), str(frame.get('message', ''))))
        # pong 与未知帧忽略

    @staticmethod
    def _safe(fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception:
            pass  # 回调异常不击穿连接循环（Python 任务死亡是无声的，必须吞掉）
