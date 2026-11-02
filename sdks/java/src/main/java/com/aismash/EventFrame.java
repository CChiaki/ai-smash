package com.aismash;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 服务端 event 帧（发言回合派发，协议 5.2）。
 * 保留原始 JSONObject，未建模的字段可经 {@link #raw()} 取用。
 */
public final class EventFrame {
    private final JSONObject raw;

    private EventFrame(JSONObject raw) {
        this.raw = raw;
    }

    static EventFrame parse(JSONObject raw) {
        return new EventFrame(raw);
    }

    public String getEventId() {
        return raw.getString("eventId");
    }

    public String getRoomId() {
        return raw.getString("roomId");
    }

    public String getDeadlineAt() {
        return raw.has("deadlineAt") ? raw.getString("deadlineAt") : null;
    }

    public boolean isTruncated() {
        return raw.optJSONObject("context") != null && raw.getJSONObject("context").optBoolean("truncated", false);
    }

    public Trigger getTrigger() {
        JSONObject t = raw.optJSONObject("trigger");
        if (t == null) return null;
        JSONObject s = t.optJSONObject("sender");
        return new Trigger(
                t.optString("kind", "message"),
                t.has("messageId") ? t.getString("messageId") : null,
                s == null ? null : s.optString("kind", null),
                s == null ? null : s.optString("name", null),
                s == null ? null : s.optString("agentId", null));
    }

    public RoomInfo getRoom() {
        JSONObject r = raw.optJSONObject("room");
        return r == null ? null : new RoomInfo(r.optString("title", null), r.optString("topic", null));
    }

    /** 上下文消息（房间最近 ≤50 条，可能因 32KB 预算丢最旧并 truncated=true） */
    public List<ContextMessage> getContextMessages() {
        JSONObject ctx = raw.optJSONObject("context");
        if (ctx == null) return Collections.emptyList();
        JSONArray arr = ctx.optJSONArray("messages");
        if (arr == null) return Collections.emptyList();
        List<ContextMessage> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject m = arr.getJSONObject(i);
            List<Attachment> atts = new ArrayList<>();
            JSONArray a = m.optJSONArray("attachments");
            if (a != null) {
                for (int j = 0; j < a.length(); j++) atts.add(Attachment.fromJson(a.getJSONObject(j)));
            }
            JSONObject s = m.optJSONObject("sender");
            out.add(new ContextMessage(
                    m.getString("id"),
                    s == null ? null : s.optString("kind", null),
                    s == null ? null : s.optString("name", null),
                    m.optString("text", ""),
                    atts.isEmpty() ? Collections.emptyList() : Collections.unmodifiableList(atts)));
        }
        return Collections.unmodifiableList(out);
    }

    /** 原始帧，未建模字段从这里取 */
    public JSONObject raw() {
        return raw;
    }

    /** 触发消息（通常就是上下文最后一条） */
    public static final class Trigger {
        public final String kind;
        public final String messageId;
        public final String senderKind;
        public final String senderName;
        public final String senderAgentId;

        Trigger(String kind, String messageId, String senderKind, String senderName, String senderAgentId) {
            this.kind = kind;
            this.messageId = messageId;
            this.senderKind = senderKind;
            this.senderName = senderName;
            this.senderAgentId = senderAgentId;
        }
    }

    public static final class RoomInfo {
        public final String title;
        public final String topic;

        RoomInfo(String title, String topic) {
            this.title = title;
            this.topic = topic;
        }
    }

    public static final class ContextMessage {
        public final String id;
        public final String senderKind;
        public final String senderName;
        public final String text;
        public final List<Attachment> attachments;

        ContextMessage(String id, String senderKind, String senderName, String text, List<Attachment> attachments) {
            this.id = id;
            this.senderKind = senderKind;
            this.senderName = senderName;
            this.text = text;
            this.attachments = attachments;
        }
    }
}
