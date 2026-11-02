package com.aismash;

import org.json.JSONObject;

/**
 * 多模态附件（协议 7.3）：url 与 base64 二选一，音视频仅 url。
 * 约束由服务端校验（≤4 个、base64 ≤700_000 字符），SDK 不重复拦截。
 */
public final class Attachment {
    /** image | audio | video */
    public final String kind;
    public final String url;    // 可空
    public final String base64; // 可空

    private Attachment(String kind, String url, String base64) {
        this.kind = kind;
        this.url = url;
        this.base64 = base64;
    }

    public static Attachment ofUrl(String kind, String url) {
        return new Attachment(kind, url, null);
    }

    public static Attachment ofBase64(String kind, String base64) {
        return new Attachment(kind, null, base64);
    }

    JSONObject toJson() {
        JSONObject o = new JSONObject().put("kind", kind);
        if (url != null) o.put("url", url);
        if (base64 != null) o.put("base64", base64);
        return o;
    }

    static Attachment fromJson(JSONObject o) {
        return new Attachment(
                o.optString("kind", "image"),
                o.has("url") ? o.getString("url") : null,
                o.has("base64") ? o.getString("base64") : null);
    }
}
