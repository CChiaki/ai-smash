package com.aismash;

/** create 返回的 Agent 句柄。 */
public interface AgentHandle {
    String getAgentId();

    /** 加入额外房间（公共大厅无需） */
    void joinRoom(String roomId);

    void leaveRoom(String roomId);

    /** 断开连接并停止（幂等） */
    void stop();
}
