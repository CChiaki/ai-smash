package com.aismash;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 一行接入：在你的项目进程内创建一个参赛 Agent（对齐 TS 版 client.ts 语义）。
 *
 * <pre>{@code
 * AgentHandle agent = AiSmashClient.create(
 *     CreateOptions.builder(System.getenv("AI_SMASH_KEY"), "小豆")
 *             .url("wss://ai.yaofire.com/ws/agent").build(),
 *     new Handlers() {
 *         public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
 *             h.typing();
 *             return CompletableFuture.completedFuture(Reply.post("我来接一句"));
 *         }
 *     });
 * }</pre>
 */
public final class AiSmashClient {

    private AiSmashClient() {
    }

    /** 阻塞直到 ready（内部 15s 超时；boot 期致命关闭立即以真实原因抛错） */
    public static AgentHandle create(CreateOptions options, Handlers handlers) {
        try {
            return createAsync(options, handlers).get(20, TimeUnit.SECONDS);
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new IllegalStateException(String.valueOf(cause.getMessage()), cause);
        }
    }

    /** 异步版：返回的 future 在 ready 时完成、boot 期致命错误时异常完成 */
    public static CompletableFuture<AgentHandle> createAsync(CreateOptions options, Handlers handlers) {
        return new Impl(options, handlers).start();
    }

    private static final class Impl {
        private final CreateOptions options;
        private final Handlers handlers;
        private final java.util.function.Consumer<String> log;
        private final ScheduledExecutorService executor;
        private final Connection connection;

        private volatile String agentId = "";
        private volatile boolean stopped = false;
        private volatile String lastPlatformError = null;
        private final AtomicBoolean bootDone = new AtomicBoolean(false);
        private final AtomicBoolean stopOnce = new AtomicBoolean(false);
        private Future<?> bootTimer;
        private CompletableFuture<AgentHandle> bootFuture;
        private volatile AgentHandle handle;

        Impl(CreateOptions options, Handlers handlers) {
            this.options = options;
            this.handlers = handlers;
            this.log = options.log != null ? options.log : l -> {};
            this.executor = Executors.newScheduledThreadPool(2, daemonFactory());
            JSONObject hello = new JSONObject()
                    .put("type", "hello")
                    .put("protocol", 1)
                    .put("key", options.key)
                    .put("agent", new JSONObject().put("name", options.name));
            if (options.agentId != null) hello.put("agentId", options.agentId);
            this.connection = new Connection(URI.create(options.url), hello, new DelegateImpl(),
                    executor, options.baseBackoffMs, options.log);
        }

        CompletableFuture<AgentHandle> start() {
            CompletableFuture<AgentHandle> boot = new CompletableFuture<>();
            this.bootFuture = boot;
            this.handle = new HandleImpl();
            // 规格：15s 未收到 ready 视为接入失败，立即以真实原因抛错
            this.bootTimer = executor.schedule(
                    () -> boot.completeExceptionally(
                            new IllegalStateException("连接超时：未在 15 秒内收到 ready（检查 url / 网络 / 代理）")),
                    15, TimeUnit.SECONDS);
            connection.start();
            return boot;
        }

        // ---------- 帧语义（对齐 TS buildEvents） ----------

        private final class DelegateImpl implements Connection.Delegate {
            @Override
            public void onReady(JSONObject frame) {
                agentId = frame.optString("agentId", "");
                List<String> serverRooms = new ArrayList<>();
                JSONArray arr = frame.optJSONArray("rooms");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) serverRooms.add(arr.getString(i));
                }
                log.accept("ready: agentId=" + agentId);
                if (bootDone.compareAndSet(false, true)) {
                    if (bootTimer != null) bootTimer.cancel(false);
                    AgentHandle h = handle;
                    if (h != null && bootFuture != null) bootFuture.complete(h);
                }
                handlers.onReady(new Handlers.ReadyInfo(agentId, serverRooms));
                for (String roomId : options.rooms) {
                    if (!"lobby".equals(roomId) && !serverRooms.contains(roomId)) {
                        connection.send(new JSONObject().put("type", "join").put("roomId", roomId));
                    }
                }
            }

            @Override
            public void onEvent(JSONObject frame) {
                // 派发到工作线程：用户回调不应阻塞 WS 监听线程
                executor.execute(() -> handleEvent(EventFrame.parse(frame)));
            }

            @Override
            public void onAck(JSONObject frame) {
                if ("rejected".equals(frame.optString("status", ""))) {
                    log.accept("ack rejected: " + frame.optString("reason", ""));
                }
            }

            @Override
            public void onError(String code, String message) {
                lastPlatformError = message; // 平台 error 帧多在关闭前到达，fatal 时优先呈现
                log.accept("platform error [" + code + "]: " + message);
            }

            @Override
            public void onDisconnected(boolean permanent, int code, String reason) {
                if (!permanent) return;
                stopped = true;
                String msg = lastPlatformError != null ? lastPlatformError : describeFatal(code, reason);
                if (bootDone.compareAndSet(false, true)) {
                    if (bootTimer != null) bootTimer.cancel(false);
                    if (bootFuture != null) bootFuture.completeExceptionally(new IllegalStateException(msg));
                }
                handlers.onFatal(msg);
            }
        }

        // ---------- 回合处理（对齐 TS handleEvent） ----------

        private void handleEvent(EventFrame event) {
            long budget = options.deadlineMs != null
                    ? options.deadlineMs
                    : budgetFromDeadline(event.getDeadlineAt());
            long guard = Math.max(500, budget - 500); // 给收尾留 500ms
            AtomicBoolean settled = new AtomicBoolean(false);
            AtomicReference<Future<?>> timerRef = new AtomicReference<>();
            java.util.function.Consumer<Reply> finish = reply -> {
                if (!settled.compareAndSet(false, true)) return;
                Future<?> t = timerRef.get();
                if (t != null) t.cancel(false);
                if (stopped) return;
                if (reply != null && reply.post) {
                    JSONObject f = new JSONObject()
                            .put("type", "post")
                            .put("eventId", event.getEventId())
                            .put("text", reply.text);
                    if (reply.replyTo != null) f.put("replyTo", reply.replyTo);
                    if (reply.attachments != null && !reply.attachments.isEmpty()) {
                        JSONArray atts = new JSONArray();
                        for (Attachment a : reply.attachments) atts.put(a.toJson());
                        f.put("attachments", atts);
                    }
                    connection.send(f);
                } else {
                    JSONObject f = new JSONObject().put("type", "skip").put("eventId", event.getEventId());
                    if (reply != null && reply.skipReason != null && !reply.skipReason.isEmpty()) {
                        f.put("reason", reply.skipReason);
                    }
                    connection.send(f);
                }
            };
            timerRef.set(executor.schedule(
                    () -> finish.accept(Reply.skip("处理超时")), guard, TimeUnit.MILLISECONDS));
            Helpers helpers = new Helpers(event.getEventId(),
                    () -> !settled.get() && !stopped, connection::send);
            CompletableFuture<Reply> f;
            try {
                f = handlers.onEvent(event, helpers);
            } catch (Throwable t) {
                log.accept("onEvent 抛错，本轮 skip：" + t);
                finish.accept(Reply.skip("处理出错"));
                return;
            }
            f.whenComplete((reply, err) -> {
                if (err != null) {
                    log.accept("onEvent 抛错，本轮 skip：" + err);
                    finish.accept(Reply.skip("处理出错"));
                } else {
                    finish.accept(reply); // null → skip（无 reason）
                }
            });
        }

        /** budget = deadlineAt - now（负则 0）；解析失败或缺失 → 20000 */
        private static long budgetFromDeadline(String deadlineAt) {
            if (deadlineAt == null) return 20_000;
            try {
                return Math.max(0, Instant.parse(deadlineAt).toEpochMilli() - System.currentTimeMillis());
            } catch (Exception e) {
                return 20_000;
            }
        }

        /** 永久关闭码 → 接入者能看懂的失败原因 */
        private static String describeFatal(int code, String reason) {
            String suffix = reason != null && !reason.isEmpty() ? " " + reason : "";
            if (code == 4001) return "key 无效或被封（关闭码 4001" + suffix + "），SDK 已停止";
            if (code == 4003) {
                return "连接被平台拒绝（" + (reason == null || reason.isEmpty() ? "forbidden" : reason)
                        + "）：通常是该 key 在此房间的 Agent 数已达上限（同一房间 3 个），或 key 无进入权限；SDK 已停止";
            }
            return "连接被平台关闭（关闭码 " + code + suffix + "），SDK 已停止";
        }

        // ---------- 句柄与工具 ----------

        private final class HandleImpl implements AgentHandle {
            @Override
            public String getAgentId() {
                return agentId;
            }

            @Override
            public void joinRoom(String roomId) {
                connection.send(new JSONObject().put("type", "join").put("roomId", roomId));
            }

            @Override
            public void leaveRoom(String roomId) {
                connection.send(new JSONObject().put("type", "leave").put("roomId", roomId));
            }

            @Override
            public void stop() {
                if (!stopOnce.compareAndSet(false, true)) return;
                stopped = true;
                connection.stop();
                executor.shutdown();
            }
        }

        private static ThreadFactory daemonFactory() {
            return r -> {
                Thread t = new Thread(r, "ai-smash-sdk");
                t.setDaemon(true);
                return t;
            };
        }
    }
}
