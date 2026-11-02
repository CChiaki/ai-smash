package com.aismash;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 测试专用：手写最小 RFC6455 服务端（握手 / 文本帧编解码 / 客户端帧去掩码 / ping→pong / close）。
 * 仅支持文本帧与控制帧，够本套单测使用；绑定 127.0.0.1 随机端口。
 */
final class MiniWsServer implements AutoCloseable {
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final ServerSocket serverSocket;
    private final ExecutorService acceptPool = Executors.newSingleThreadExecutor(r -> daemon(r, "mini-ws-accept"));
    private final ExecutorService connPool = Executors.newCachedThreadPool(r -> daemon(r, "mini-ws-conn"));
    final List<Conn> connections = new CopyOnWriteArrayList<>();
    private volatile boolean running = true;

    MiniWsServer() throws IOException {
        this.serverSocket = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        acceptPool.execute(this::acceptLoop);
    }

    int port() {
        return serverSocket.getLocalPort();
    }

    URI uri() {
        return URI.create("ws://127.0.0.1:" + port() + "/ws/agent");
    }

    /** 最近一条连接（等待其出现） */
    Conn awaitConnection(long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (!connections.isEmpty()) return connections.get(connections.size() - 1);
            Thread.sleep(10);
        }
        return connections.isEmpty() ? null : connections.get(connections.size() - 1);
    }

    /** 等到第 knownCount+1 条连接（重连用：避免拿到旧连接） */
    Conn awaitNewConnection(int knownCount, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (connections.size() > knownCount) return connections.get(knownCount);
            Thread.sleep(10);
        }
        return connections.size() > knownCount ? connections.get(knownCount) : null;
    }

    int connectionCount() {
        return connections.size();
    }

    @Override
    public void close() throws IOException {
        running = false;
        try {
            serverSocket.close();
        } finally {
            for (Conn c : connections) c.quietClose();
            acceptPool.shutdownNow();
            connPool.shutdownNow();
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = serverSocket.accept();
                Conn c = new Conn(s);
                connections.add(c);
                connPool.execute(c::run);
            } catch (IOException e) {
                return; // close() 时正常到达
            }
        }
    }

    private static Thread daemon(Runnable r, String name) {
        Thread t = new Thread(r, name);
        t.setDaemon(true);
        return t;
    }

    /** 单条客户端连接：HTTP 升级 + 帧循环 */
    final class Conn {
        final Socket socket;
        /** 收到的完整文本消息 */
        final BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        /** 收到的对端关闭码 */
        final BlockingQueue<Integer> closeCodes = new LinkedBlockingQueue<>();
        private volatile boolean open = true;

        Conn(Socket socket) {
            this.socket = socket;
        }

        void run() {
            try {
                handshake();
                readLoop();
            } catch (Exception e) {
                quietClose();
            }
        }

        /** 等待一条完整文本消息 */
        String awaitMessage(long timeoutMs) throws InterruptedException {
            return messages.poll(timeoutMs, TimeUnit.MILLISECONDS);
        }

        /** 等待客户端回关的关闭码 */
        Integer awaitClose(long timeoutMs) throws InterruptedException {
            return closeCodes.poll(timeoutMs, TimeUnit.MILLISECONDS);
        }

        void sendText(String text) {
            try {
                writeFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                quietClose();
            }
        }

        /** 服务端发起关闭（发 close 帧后稍候再断 TCP，给客户端留出读取时间） */
        void sendClose(int code, String reason) {
            try {
                byte[] reasonBytes = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
                byte[] payload = new byte[2 + reasonBytes.length];
                payload[0] = (byte) ((code >> 8) & 0xFF);
                payload[1] = (byte) (code & 0xFF);
                System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
                writeFrame(0x8, payload);
                Thread.sleep(150);
                quietClose();
            } catch (Exception e) {
                quietClose();
            }
        }

        // ---------- 内部实现 ----------

        private void handshake() throws Exception {
            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
            String secKey = null;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                if (line.length() > 20 && line.substring(0, 18).equalsIgnoreCase("sec-websocket-key:")) {
                    secKey = line.substring(18).trim();
                }
            }
            if (secKey == null) throw new IOException("缺少 Sec-WebSocket-Key");
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((secKey + WS_GUID).getBytes(StandardCharsets.ISO_8859_1));
            String accept = Base64.getEncoder().encodeToString(digest);
            String resp = "HTTP/1.1 101 Switching Protocols\r\n"
                    + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            socket.getOutputStream().write(resp.getBytes(StandardCharsets.ISO_8859_1));
            socket.getOutputStream().flush();
        }

        /** 手工按字节读一行（必须二进制流上读，避免缓冲区吃掉后续帧字节） */
        private String readLine(DataInputStream in) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            int prev = -1;
            int b;
            while ((b = in.read()) != -1) {
                if (prev == '\r' && b == '\n') break;
                if (prev != -1) buf.write(prev);
                prev = b;
            }
            if (buf.size() == 0 && prev == -1) return null;
            return buf.toString("ISO-8859-1");
        }

        private void readLoop() throws IOException {
            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
            StringBuilder text = new StringBuilder();
            while (open) {
                int b0 = in.readUnsignedByte();
                int b1 = in.readUnsignedByte();
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) len = in.readUnsignedShort();
                else if (len == 127) len = in.readLong();
                byte[] mask = new byte[4];
                if (masked) in.readFully(mask);
                byte[] payload = new byte[(int) len];
                in.readFully(payload);
                if (masked) {
                    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                }
                switch (opcode) {
                    case 0x0: // continuation
                    case 0x1: // text
                        text.append(new String(payload, StandardCharsets.UTF_8));
                        if (fin) {
                            messages.offer(text.toString());
                            text.setLength(0);
                        }
                        break;
                    case 0x8: // close：回以相同码并断开
                        int code = payload.length >= 2
                                ? ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF)
                                : 1005;
                        closeCodes.offer(code);
                        open = false;
                        try {
                            writeFrame(0x8, payload.length >= 2
                                    ? new byte[] { payload[0], payload[1] } : new byte[0]);
                        } catch (IOException ignored) {
                            // 对端可能已断
                        }
                        quietClose();
                        break;
                    case 0x9: // ping → pong
                        writeFrame(0xA, payload);
                        break;
                    default:
                        break; // binary/pong 忽略
                }
            }
        }

        /** 服务端→客户端帧不掩码（RFC 6455） */
        private synchronized void writeFrame(int opcode, byte[] payload) throws IOException {
            if (!open && opcode != 0x8) return;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            buf.write(0x80 | opcode);
            if (payload.length < 126) {
                buf.write(payload.length);
            } else if (payload.length < 65536) {
                buf.write(126);
                buf.write((payload.length >> 8) & 0xFF);
                buf.write(payload.length & 0xFF);
            } else {
                buf.write(127);
                for (int i = 7; i >= 0; i--) buf.write((int) ((long) payload.length >> (8 * i)) & 0xFF);
            }
            buf.write(payload);
            OutputStream out = socket.getOutputStream();
            out.write(buf.toByteArray());
            out.flush();
        }

        void quietClose() {
            open = false;
            try {
                socket.close();
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }
}
