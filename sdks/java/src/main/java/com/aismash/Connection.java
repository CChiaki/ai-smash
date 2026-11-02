package com.aismash;

import org.json.JSONObject;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 连接层（对齐 TS 版 connection.ts）：握手 hello、帧分发、断线指数退避重连。
 * 发送经 CompletableFuture 链串行化（JDK WebSocket 同时只允许一个在途 send）。
 * 协议层 ping/pong 由 JDK 自动应答，无需手写心跳。
 */
final class Connection {

    /** 帧回调（语义层处理） */
    interface Delegate {
        void onReady(JSONObject frame);

        void onEvent(JSONObject frame);

        void onAck(JSONObject frame);

        void onError(String code, String message);

        /** 永久断开（4001/4003）时上层负责 fatal，不再重连 */
        void onDisconnected(boolean permanent, int code, String reason);
    }

    private final URI uri;
    private final JSONObject hello;
    private final Delegate delegate;
    private final ScheduledExecutorService scheduler;
    private final HttpClient http;
    private final java.util.function.Consumer<String> log;

    private volatile boolean stopped = false;
    private volatile long backoffMs;
    private final long baseBackoffMs;

    /** 当前连接状态（每代连接独立，重连后刷新） */
    private volatile Conn current;
    /** 发送链尾：串行化所有 sendText，避免 IllegalStateException */
    private final AtomicReference<CompletableFuture<Void>> sendTail =
            new AtomicReference<>(CompletableFuture.completedFuture(null));
    private final Object sendLock = new Object();

    Connection(URI uri, JSONObject hello, Delegate delegate,
               ScheduledExecutorService scheduler, long baseBackoffMs,
               java.util.function.Consumer<String> log) {
        this.uri = uri;
        this.hello = hello;
        this.delegate = delegate;
        this.scheduler = scheduler;
        this.baseBackoffMs = baseBackoffMs;
        this.backoffMs = baseBackoffMs;
        this.log = log != null ? log : l -> {};
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    void start() {
        connect();
    }

    /** 发送一帧；连接不可用时静默丢弃（对齐 TS readyState 检查） */
    void send(JSONObject frame) {
        Conn c = current;
        if (c == null || c.ws.isOutputClosed()) return;
        synchronized (sendLock) {
            CompletableFuture<Void> next = sendTail.get()
                    .thenCompose(v -> c.ws.sendText(frame.toString(), true))
                    .thenApply(w -> null);
            next = next.whenComplete((r, e) -> {
                if (e != null) log.accept("send 失败: " + e);
            });
            sendTail.set(next.exceptionally(e -> null)); // 链不进异常态，后续帧照发
        }
    }

    void stop() {
        stopped = true;
        Conn c = current;
        if (c != null) {
            try {
                c.ws.sendClose(WebSocket.NORMAL_CLOSURE, "bridge_shutdown");
            } catch (Exception ignored) {
                // 已关闭则忽略
            }
        }
    }

    private void connect() {
        if (stopped) return;
        AtomicReference<Conn> holder = new AtomicReference<>();
        WebSocket.Listener listener = new WebSocket.Listener() {
            @Override
            public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                Conn c = holder.get();
                if (c != null) {
                    c.text.append(data);
                    if (last) {
                        dispatch(c.text.toString());
                        c.text.setLength(0);
                    }
                }
                ws.request(1);
                return null;
            }

            @Override
            public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
                handleClose(statusCode, reason);
                return null;
            }

            @Override
            public void onError(WebSocket ws, Throwable error) {
                // 不处理：随后 onClose 会被调用（对齐 TS：error 后 close 跟随）
            }
        };
        http.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .buildAsync(uri, listener)
                .whenComplete((WebSocket ws, Throwable err) -> {
                    if (err != null) {
                        handleClose(1006, "connect_failed");
                        return;
                    }
                    Conn c = new Conn(ws);
                    holder.set(c);
                    current = c;
                    send(hello); // open 即握手（对齐 TS on open send hello）
                });
    }

    private void dispatch(String text) {
        JSONObject frame;
        try {
            frame = new JSONObject(text);
        } catch (Exception e) {
            return; // 非法帧静默丢弃
        }
        String type = frame.optString("type", "");
        switch (type) {
            case "ready":
                backoffMs = baseBackoffMs; // 重置退避
                delegate.onReady(frame);
                break;
            case "event":
                delegate.onEvent(frame);
                break;
            case "ack":
                delegate.onAck(frame);
                break;
            case "error":
                delegate.onError(frame.optString("code", ""), frame.optString("message", ""));
                break;
            default:
                // pong/joined/state 不需要处理（对齐 TS）
                break;
        }
    }

    private void handleClose(int code, String reason) {
        if (stopped) return;
        // 4001 = key 无效/被封；4003 = 引擎语义拒绝——重连也不会成功，按永久断开处理
        boolean permanent = code == 4001 || code == 4003;
        delegate.onDisconnected(permanent, code, reason);
        if (permanent) return; // 不重试，由上层退出
        long delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, 30_000);
        scheduler.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
    }

    /** 单代连接：独立的消息累积缓冲（onClose 由 JDK 保证至多一次，无需去重） */
    private static final class Conn {
        final WebSocket ws;
        final StringBuilder text = new StringBuilder();

        Conn(WebSocket ws) {
            this.ws = ws;
        }
    }
}
