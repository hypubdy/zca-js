import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createBackend } from "./backend.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4320);
const iceServers = JSON.parse(process.env.ICE_SERVERS || "[]");
const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
for (const origin of (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)) allowedOrigins.add(origin);

const sockets = new Set();
function publish(event, data = {}) {
    const frame = JSON.stringify({ event, data });
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
}
const backend = createBackend({ publish, iceServers });

function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}
async function readBody(req, limit = 256 * 1024) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error("Body too large"), { statusCode: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const files = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"] };

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (req.method === "POST" && url.pathname === "/api/call") {
        if (!allowedOrigins.has(req.headers.origin)) return sendJson(res, 403, { ok: false, error: "Origin not allowed" });
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return sendJson(res, 415, { ok: false, error: "JSON only" });
        try {
            const request = JSON.parse(await readBody(req));
            if (!request || typeof request.action !== "string") return sendJson(res, 400, { ok: false, error: "Missing action" });
            return sendJson(res, 200, { ok: true, data: await backend.handle(request.action, request.data || {}) });
        } catch (error) {
            // CallError messages are already redacted by the library.
            return sendJson(res, error.statusCode || 400, { ok: false, error: error instanceof SyntaxError ? "Invalid JSON" : error.message, code: error.code });
        }
    }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/api/status") return sendJson(res, 200, backend.snapshot());
    if (url.pathname === "/api/config") return sendJson(res, 200, { iceServers });
    const file = files[url.pathname];
    if (!file) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
    fs.createReadStream(path.join(root, "web", file[0])).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname !== "/ws" || !allowedOrigins.has(req.headers.origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws);
        ws.send(JSON.stringify({ event: "snapshot", data: backend.snapshot() }));
        ws.on("message", () => ws.close(1008, "Events only"));
        ws.on("close", () => sockets.delete(ws));
    });
});

server.listen(port, host, () => console.log(`Call audio starter: http://${host}:${port}`));
async function shutdown() {
    await backend.close().catch(() => {});
    wss.close(); server.close();
    // @roamhq/wrtc can segfault during native teardown at a normal exit; exit explicitly.
    process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
