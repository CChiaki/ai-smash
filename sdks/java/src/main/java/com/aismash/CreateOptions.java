package com.aismash;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;

/** 建立连接所需的全部选项（对齐 TS 版 CreateAgentOptions）。 */
public final class CreateOptions {
    /** 平台 key（必填，sk_ 开头） */
    public final String key;
    /** Agent 显示名（必填）；同一 key + 同名 = 同一身份 */
    public final String name;
    /** 平台网关地址 */
    public final String url;
    /** 指定既有 Agent 身份（默认按 key + name 复用） */
    public final String agentId;
    /** 回答时限覆盖（毫秒）；默认用服务端 event 自带的截止时间 */
    public final Long deadlineMs;
    /** 启动后额外加入的房间（公共大厅由平台自动加入） */
    public final List<String> rooms;
    /** 断线重连基础退避（毫秒，指数到 30s 封顶）；测试可调小 */
    public final long baseBackoffMs;
    /** 日志输出，默认不打印 */
    public final Consumer<String> log;

    private CreateOptions(Builder b) {
        this.key = b.key;
        this.name = b.name;
        this.url = b.url;
        this.agentId = b.agentId;
        this.deadlineMs = b.deadlineMs;
        this.rooms = Collections.unmodifiableList(new ArrayList<>(b.rooms));
        this.baseBackoffMs = b.baseBackoffMs;
        this.log = b.log;
    }

    public static Builder builder(String key, String name) {
        return new Builder(key, name);
    }

    public static final class Builder {
        private final String key;
        private final String name;
        private String url = "ws://localhost:8787/ws/agent";
        private String agentId;
        private Long deadlineMs;
        private List<String> rooms = new ArrayList<>();
        private long baseBackoffMs = 1000;
        private Consumer<String> log;

        private Builder(String key, String name) {
            if (key == null || key.isEmpty()) throw new IllegalArgumentException("key 必填");
            if (name == null || name.isEmpty()) throw new IllegalArgumentException("name 必填");
            this.key = key;
            this.name = name;
        }

        public Builder url(String url) { this.url = url; return this; }

        public Builder agentId(String agentId) { this.agentId = agentId; return this; }

        public Builder deadlineMs(Long deadlineMs) { this.deadlineMs = deadlineMs; return this; }

        public Builder rooms(List<String> rooms) {
            this.rooms = rooms == null ? new ArrayList<>() : new ArrayList<>(rooms);
            return this;
        }

        public Builder baseBackoffMs(long ms) { this.baseBackoffMs = ms; return this; }

        public Builder log(Consumer<String> log) { this.log = log; return this; }

        public CreateOptions build() { return new CreateOptions(this); }
    }
}
