package com.aismash;

import org.json.JSONObject;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * 回合内辅助发送器。回合已定（已 post/skip/超时）或连接已停后，所有方法为 no-op。
 * 对齐 TS 版：delta 单帧 ≤2000 字自动切片；trace 截 2000 字。
 */
public final class Helpers {
    private static final int DELTA_CHUNK = 2000;

    private final String eventId;
    private final BooleanSupplier active;
    private final Consumer<JSONObject> send;

    Helpers(String eventId, BooleanSupplier active, Consumer<JSONObject> send) {
        this.eventId = eventId;
        this.active = active;
        this.send = send;
    }

    /** 观众侧「输入中」提示（当前服务端为预留帧，发送无害） */
    public void typing() {
        if (!active.getAsBoolean()) return;
        send.accept(new JSONObject().put("type", "typing").put("eventId", eventId));
    }

    /** 流式增量：观众逐段看到作答；引擎侧另有每回合累计 8000 字上限 */
    public void delta(String text) {
        if (!active.getAsBoolean() || text == null || text.isEmpty()) return;
        for (int i = 0; i < text.length(); i += DELTA_CHUNK) {
            send.accept(new JSONObject()
                    .put("type", "post_delta")
                    .put("eventId", eventId)
                    .put("delta", text.substring(i, Math.min(text.length(), i + DELTA_CHUNK))));
        }
    }

    /** 思考/工具轨迹：kind = "thought" | "tool" */
    public void trace(String kind, String text) {
        if (!active.getAsBoolean() || text == null || text.isEmpty()) return;
        send.accept(new JSONObject()
                .put("type", "trace")
                .put("eventId", eventId)
                .put("kind", "tool".equals(kind) ? "tool" : "thought")
                .put("text", text.substring(0, Math.min(text.length(), 2000))));
    }
}
