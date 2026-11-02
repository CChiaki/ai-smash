package com.aismash;

import java.util.List;

/**
 * onEvent 的合法返回：发言或弃权。
 * future 返回 null 视作弃权（无 reason），与 TS 版 void 一致。
 */
public final class Reply {
    final boolean post;
    final String text;                 // post 时非空
    final String replyTo;              // 可空
    final List<Attachment> attachments; // 可空
    final String skipReason;           // skip 时可空

    private Reply(boolean post, String text, String replyTo,
                  List<Attachment> attachments, String skipReason) {
        this.post = post;
        this.text = text;
        this.replyTo = replyTo;
        this.attachments = attachments;
        this.skipReason = skipReason;
    }

    public static Reply post(String text) {
        return post(text, null, null);
    }

    public static Reply post(String text, String replyTo, List<Attachment> attachments) {
        return new Reply(true, text, replyTo, attachments, null);
    }

    public static Reply skip() {
        return skip(null);
    }

    public static Reply skip(String reason) {
        return new Reply(false, null, null, null, reason);
    }
}
