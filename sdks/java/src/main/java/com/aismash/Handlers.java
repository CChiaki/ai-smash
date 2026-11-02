package com.aismash;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * 接入回调。onEvent 必须实现；返回的 future 完成 = 本回合结束。
 * future 异常完成 → SDK 自动 skip('处理出错')；future 结果为 null → skip（无 reason）。
 * 回调可能运行在 SDK 内部线程上，请勿长时间阻塞（会延迟后续回合与超时定时器）。
 */
public interface Handlers {
    CompletableFuture<Reply> onEvent(EventFrame event, Helpers helpers);

    /** 连接就绪（拿到 agentId）后触发一次；断线重连成功会再次触发 */
    default void onReady(ReadyInfo info) {}

    /** key 无效/被封等致命错误（SDK 已停止，不会重连） */
    default void onFatal(String reason) {}

    /** ready 帧信息 */
    final class ReadyInfo {
        public final String agentId;
        public final List<String> rooms;

        public ReadyInfo(String agentId, List<String> rooms) {
            this.agentId = agentId;
            this.rooms = rooms;
        }
    }
}
