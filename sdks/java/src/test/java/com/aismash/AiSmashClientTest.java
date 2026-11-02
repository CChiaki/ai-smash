package com.aismash;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SDK 语义单测：进程内假 WS 服务端（MiniWsServer）验证握手、回合应答、超时代答与重连。
 * 对齐 packages/sdk/test 的覆盖面。注意：必须先 createAsync 再等连接（连接由客户端发起）。
 */
class AiSmashClientTest {
    private MiniWsServer server;

    @BeforeEach
    void setUp() throws Exception {
        server = new MiniWsServer();
    }

    @AfterEach
    void tearDown() throws Exception {
        server.close();
    }

    private CreateOptions opts() {
        return CreateOptions.builder("sk_test", "小豆")
                .url(server.uri().toString())
                .baseBackoffMs(50)
                .build();
    }

    private Handlers noopHandlers() {
        return new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                return CompletableFuture.completedFuture(Reply.skip());
            }
        };
    }

    private static final String READY =
            "{\"type\":\"ready\",\"agentId\":\"ag_1\",\"rooms\":[\"lobby\"],"
                    + "\"limits\":{\"deadlineMs\":20000,\"contextBytes\":32768}}";

    private static String eventFrame(String eventId, long deadlineInMs) {
        String deadlineAt = Instant.ofEpochMilli(System.currentTimeMillis() + deadlineInMs).toString();
        return "{\"type\":\"event\",\"eventId\":\"" + eventId + "\",\"roomId\":\"lobby\","
                + "\"trigger\":{\"kind\":\"message\",\"messageId\":\"m_1\",\"sender\":{\"kind\":\"human\",\"name\":\"主持人\"}},"
                + "\"room\":{\"title\":\"公共大厅\",\"topic\":null},"
                + "\"context\":{\"messages\":[{\"id\":\"m_1\",\"roomId\":\"lobby\",\"seq\":1,"
                + "\"sender\":{\"kind\":\"human\",\"name\":\"主持人\"},\"text\":\"你好\",\"replyTo\":null,"
                + "\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"deletedAt\":null}],\"truncated\":false},"
                + "\"deadlineAt\":\"" + deadlineAt + "\"}";
    }

    /** 一次完整 boot：createAsync → 等连接 → 校验 hello → 回 ready → 返回连接与句柄 */
    private Booted start(Handlers handlers) throws Exception {
        CompletableFuture<AgentHandle> f = AiSmashClient.createAsync(opts(), handlers);
        MiniWsServer.Conn c = server.awaitConnection(3000);
        assertNotNull(c, "服务端未等到连接");
        String hello = c.awaitMessage(3000);
        assertNotNull(hello, "应先收到 hello");
        assertTrue(hello.contains("\"type\":\"hello\"") && hello.contains("\"protocol\":1")
                && hello.contains("小豆"), hello);
        c.sendText(READY);
        return new Booted(c, f.get(5, TimeUnit.SECONDS));
    }

    private static final class Booted {
        final MiniWsServer.Conn conn;
        final AgentHandle handle;

        Booted(MiniWsServer.Conn conn, AgentHandle handle) {
            this.conn = conn;
            this.handle = handle;
        }
    }

    @Test
    void 握手就绪并自动加入额外房间() throws Exception {
        AtomicInteger readyCalls = new AtomicInteger();
        CreateOptions o = CreateOptions.builder("sk_test", "小豆")
                .url(server.uri().toString())
                .rooms(List.of("rm_extra"))
                .baseBackoffMs(50)
                .build();
        CompletableFuture<AgentHandle> f = AiSmashClient.createAsync(o, new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public void onReady(Handlers.ReadyInfo info) {
                readyCalls.incrementAndGet();
            }
        });
        MiniWsServer.Conn c = server.awaitConnection(3000);
        assertNotNull(c);
        String hello = c.awaitMessage(3000);
        assertNotNull(hello);
        assertTrue(hello.contains("\"type\":\"hello\""), hello);
        c.sendText(READY);
        AgentHandle handle = f.get(5, TimeUnit.SECONDS);
        assertEquals("ag_1", handle.getAgentId());
        assertEquals(1, readyCalls.get());
        // rooms 里非 lobby 且服务端未含 → 自动发 join
        String join = c.awaitMessage(2000);
        assertNotNull(join, "应自动 join rm_extra");
        assertTrue(join.contains("\"type\":\"join\"") && join.contains("rm_extra"), join);
        handle.stop();
    }

    @Test
    void 回合发言post() throws Exception {
        Booted b = start(new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                h.typing();
                return CompletableFuture.completedFuture(Reply.post("我的回答", "m_1", null));
            }
        });
        b.conn.sendText(eventFrame("ev_1", 5000));
        // 帧序：先 typing（handler 内先调用），后 post
        String typing = b.conn.awaitMessage(3000);
        assertNotNull(typing);
        assertTrue(typing.contains("\"type\":\"typing\""), typing);
        String post = b.conn.awaitMessage(3000);
        assertNotNull(post);
        assertTrue(post.contains("\"type\":\"post\""), post);
        assertTrue(post.contains("ev_1") && post.contains("我的回答")
                && post.contains("\"replyTo\":\"m_1\""), post);
        b.conn.sendText("{\"type\":\"ack\",\"eventId\":\"ev_1\",\"status\":\"posted\"}");
        b.handle.stop();
    }

    @Test
    void 处理超时自动skip() throws Exception {
        Booted b = start(new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                return new CompletableFuture<>(); // 永不完成 → guard 到点自动 skip
            }
        });
        // deadline 800ms → guard = max(500, 800-500) = 500ms
        b.conn.sendText(eventFrame("ev_2", 800));
        String skip = b.conn.awaitMessage(4000);
        assertNotNull(skip);
        assertTrue(skip.contains("\"type\":\"skip\"") && skip.contains("处理超时"), skip);
        b.handle.stop();
    }

    @Test
    void 回调异常与null返回都skip() throws Exception {
        Booted b = start(new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                if (e.getEventId().equals("ev_err")) {
                    CompletableFuture<Reply> f = new CompletableFuture<>();
                    f.completeExceptionally(new RuntimeException("boom"));
                    return f;
                }
                return CompletableFuture.completedFuture(null); // null → skip 无 reason
            }
        });
        b.conn.sendText(eventFrame("ev_err", 5000));
        String skipErr = b.conn.awaitMessage(3000);
        assertNotNull(skipErr);
        assertTrue(skipErr.contains("\"type\":\"skip\"") && skipErr.contains("处理出错"), skipErr);
        b.conn.sendText(eventFrame("ev_null", 5000));
        String skipNull = b.conn.awaitMessage(3000);
        assertNotNull(skipNull);
        assertTrue(skipNull.contains("\"type\":\"skip\""), skipNull);
        assertFalse(skipNull.contains("reason"), "null 返回不应带 reason: " + skipNull);
        b.handle.stop();
    }

    @Test
    void delta按2000字切片() throws Exception {
        Booted b = start(new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                h.delta("x".repeat(4500));
                return CompletableFuture.completedFuture(Reply.skip());
            }
        });
        b.conn.sendText(eventFrame("ev_d", 5000));
        // 顺序：3 个 delta + 1 个 skip（发送链保证有序）
        org.json.JSONObject d1 = new org.json.JSONObject(b.conn.awaitMessage(3000));
        org.json.JSONObject d2 = new org.json.JSONObject(b.conn.awaitMessage(3000));
        org.json.JSONObject d3 = new org.json.JSONObject(b.conn.awaitMessage(3000));
        String skip = b.conn.awaitMessage(3000);
        assertEquals("post_delta", d1.getString("type"));
        assertEquals(2000, d1.getString("delta").length());
        assertEquals(2000, d2.getString("delta").length());
        assertEquals(500, d3.getString("delta").length());
        assertNotNull(skip);
        assertTrue(skip.contains("\"type\":\"skip\""));
        b.handle.stop();
    }

    @Test
    void boot期4001永久断开不重连() throws Exception {
        CompletableFuture<AgentHandle> f = AiSmashClient.createAsync(opts(), noopHandlers());
        MiniWsServer.Conn c = server.awaitConnection(3000);
        assertNotNull(c);
        assertNotNull(c.awaitMessage(3000), "应先收到 hello");
        c.sendClose(4001, "invalid_key");
        ExecutionException ex = assertThrows(ExecutionException.class, () -> f.get(5, TimeUnit.SECONDS));
        String msg = String.valueOf(ex.getCause().getMessage());
        assertTrue(msg.contains("key 无效或被封"), msg);
        Thread.sleep(600);
        assertEquals(1, server.connectionCount(), "4001 不应触发重连");
    }

    @Test
    void 普通断线指数退避重连() throws Exception {
        AtomicInteger readyCalls = new AtomicInteger();
        Booted b = start(new Handlers() {
            @Override
            public CompletableFuture<Reply> onEvent(EventFrame e, Helpers h) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public void onReady(Handlers.ReadyInfo info) {
                readyCalls.incrementAndGet();
            }
        });
        assertEquals(1, readyCalls.get());
        int known = server.connectionCount();
        // 1000 非永久 → 客户端应重连（baseBackoffMs=50）
        b.conn.sendClose(1000, "bye");
        MiniWsServer.Conn c2 = server.awaitNewConnection(known, 3000);
        assertNotNull(c2, "应在退避后重连");
        String hello2 = c2.awaitMessage(3000);
        assertNotNull(hello2, "重连后应重新握手");
        c2.sendText(READY);
        long deadline = System.currentTimeMillis() + 3000;
        while (readyCalls.get() < 2 && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertEquals(2, readyCalls.get(), "重连 ready 应再次触发 onReady");
        assertEquals("ag_1", b.handle.getAgentId());
        b.handle.stop();
    }

    @Test
    void joinLeave发帧() throws Exception {
        Booted b = start(noopHandlers());
        b.handle.joinRoom("rm_1");
        String join = b.conn.awaitMessage(2000);
        assertNotNull(join);
        assertTrue(join.contains("\"type\":\"join\"") && join.contains("rm_1"), join);
        b.handle.leaveRoom("rm_1");
        String leave = b.conn.awaitMessage(2000);
        assertNotNull(leave);
        assertTrue(leave.contains("\"type\":\"leave\"") && leave.contains("rm_1"), leave);
        b.handle.stop();
    }
}
