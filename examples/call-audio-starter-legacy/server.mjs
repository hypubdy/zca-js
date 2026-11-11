import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createCallBackend } from "./src/call-backend.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4320);
const iceServers = JSON.parse(process.env.ICE_SERVERS || "[]");
const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);
for (const raw of (process.env.ALLOWED_ORIGINS || "").split(",")) {
    const origin = raw.trim();
    if (!origin) continue;
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error(`Invalid origin: ${origin}`);
    allowedOrigins.add(origin);
}
const peers = new Set();
const mediaSockets = new Map();
const backend = createCallBackend({ publish, iceServers });

function publish(event, data = {}) {
    const frame = JSON.stringify({ event, data });
    for (const ws of peers) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
}
function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}
async function readBody(req, limit = 64 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) { const error = new Error("Request body quá lớn"); error.statusCode = 413; throw error; }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
function publicError(error) {
    const allow = new Set([
        "Zalo chưa kết nối", "Không tìm thấy người nhận", "Đang có cuộc gọi khác; kết thúc trước khi gọi tiếp",
        "Microphone/WebRTC chưa nối vào relay; chưa gửi lời mời", "Caller relay chưa được chuẩn bị cho đúng người nhận",
        "Microphone/WebRTC chưa sẵn sàng", "Không có cuộc gọi đến", "Cần lời mời gọi mới để đăng ký relay",
    ]);
    if (allow.has(error?.message)) return error.message;
    console.error("Call backend error:", error?.stack || error);
    return "Thao tác không thành công; xem log backend.";
}

const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host;
    if (![`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`].includes(hostHeader)) {
        res.writeHead(403).end("Unsupported host"); return;
    }
    const url = new URL(req.url, `http://${hostHeader}`);
    if (req.method === "POST" && url.pathname === "/api/call") {
        if (!allowedOrigins.has(req.headers.origin)) return sendJson(res, 403, { ok: false, error: "Origin không được phép" });
        if (!/^[a-f0-9-]{36}$/i.test(req.headers["x-call-client-id"] || "")) return sendJson(res, 400, { ok: false, error: "Thiếu client id" });
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return sendJson(res, 415, { ok: false, error: "Chỉ nhận JSON" });
        try {
            const request = JSON.parse(await readBody(req));
            if (!request || typeof request.action !== "string") return sendJson(res, 400, { ok: false, error: "Thiếu action" });
            const clientId = req.headers["x-call-client-id"];
            const mediaSocket = mediaSockets.get(clientId) || null;
            const data = await backend.handle(request.action, request.data || {}, mediaSocket);
            return sendJson(res, 200, { ok: true, data });
        } catch (error) {
            return sendJson(res, error.statusCode || (error instanceof SyntaxError ? 400 : 400), {
                ok: false, error: error instanceof SyntaxError ? "JSON không hợp lệ" : publicError(error),
            });
        }
    }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/api/config") return sendJson(res, 200, { iceServers });
    if (url.pathname === "/api/status") return sendJson(res, 200, backend.snapshot());
    const files = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript"],
        "/app.js.map": ["app.js.map", "application/json"],
    };
    const file = files[url.pathname];
    if (!file) { res.writeHead(404).end("Not found"); return; }
    const fullPath = path.join(root, "dist", file[0]);
    if (!fs.existsSync(fullPath)) { res.writeHead(503).end("Run npm run build first"); return; }
    res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
    fs.createReadStream(fullPath).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; }
    catch { socket.destroy(); return; }
    // /ws also carries the per-tab clientId query parameter used to associate
    // HTTP media commands with this browser's WebRTC socket.
    if (pathname !== "/ws" || !allowedOrigins.has(req.headers.origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientId = url.searchParams.get("clientId");
    if (!clientId || !/^[a-f0-9-]{36}$/i.test(clientId)) { ws.close(1008, "Thiếu client id"); return; }
    peers.add(ws);
    mediaSockets.set(clientId, ws);
    ws.send(JSON.stringify({ event: "connection-state", data: { state: "connected" } }));
    ws.send(JSON.stringify({ event: "snapshot", data: backend.snapshot() }));
    ws.on("message", async (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            if (message.action === "video-frame") {
                try { await backend.handle("video-frame", message.data || {}, ws); }
                catch (error) { publish("call-error", { message: publicError(error) }); }
                return;
            }
            ws.close(1008, "WebSocket chỉ nhận event và media frame");
        } catch { ws.close(1007, "Dữ liệu không hợp lệ"); }
    });
    ws.on("close", () => {
        peers.delete(ws);
        if (mediaSockets.get(clientId) === ws) mediaSockets.delete(clientId);
        void backend.clientDisconnected(ws);
    });
});

server.listen(port, host, () => console.log(`Call Audio: http://${host}:${port}`));
async function shutdown() { await backend.close(); wss.close(); server.close(); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
