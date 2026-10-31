import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { MediaSession } from "./media.mjs";
import { IndependentCall } from "./independent-call.mjs";
import { ZaloSession } from "./zalo-session.mjs";
import { safeCallError } from "./outgoing-diagnostics.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4317);
const host = "127.0.0.1";
const iceServers = JSON.parse(process.env.ICE_SERVERS || "[]");
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
for (const value of (process.env.CALL_ALLOWED_ORIGINS || "").split(",")) {
    const origin = value.trim();
    if (!origin) continue;
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
        throw new Error(`CALL_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    allowedOrigins.add(origin);
}
let media,
    owner,
    mediaInput,
    devices = [],
    lastStats;
let credentialInput;
const peers = new Set();
const log = [];
let currentQr;
let lastCameraState = null;
let lastClientVideoStats = null;
let formatCycleTimers = [];
function notify(event, data = {}) {
    if (event === "independent-video-frame") {
        // A frame is media, not a diagnostic event. Keep it out of the event
        // history and never queue it behind a slow browser WebSocket.
        if (owner?.readyState === WebSocket.OPEN && owner.bufferedAmount < 1024 * 1024)
            owner.send(JSON.stringify({ event, data }));
        return;
    }
    if (event === "zalo-qr") currentQr = data;
    if (event === "zalo-state" && ["online", "offline", "expired"].includes(data.state)) currentQr = undefined;
    if (event === "zalo-state" && data.state !== "online") independent.clear();
    if (event === "media-stats") lastStats = data;
    if (event === "independent-confirmed" && process.env.VIDEO_FORMAT_CYCLE === "1") {
        startFormatCycle();
    }
    if (event === "independent-confirmed") {
        // Zalo Desktop reports local capture state through /api/voicecall/conf
        // as soon as the camera starts; the peer's server-side control update
        // (onoff_camera) is what makes its UI/renderer accept the video leg.
        publishCameraState(1).catch(error =>
            notify("independent-error", { message: `Chưa gửi được trạng thái camera: ${error.message}` }));
    }
    if (event === "independent-offer") console.log("Incoming call offer:", JSON.stringify(data));
    const message = JSON.stringify({ event, data });
    for (const peer of peers) if (peer.readyState === WebSocket.OPEN) peer.send(message);
    if (!["media-stats", "zalo-qr", "independent-media-diagnostics", "independent-state", "independent-video-media"].includes(event) && !(event === "native" && data.playedSamples !== undefined)) {
        log.push({ time: new Date().toISOString(), event, data });
        if (log.length > 100) log.shift();
    }
}
/** A/B cycle for the outgoing video transport during one live call. */
function startFormatCycle() {
    for (const timer of formatCycleTimers) clearTimeout(timer);
    formatCycleTimers = [];
    // Native H264 constructor defaults use payload 100 while signaling
    // advertises 97, so sweep payload types as well as packetization.
    const windows = [
        { format: "nal", extensions: false, payloadType: 100 },
        { format: "nal", extensions: false, payloadType: 98 },
        { format: "nal", extensions: true, payloadType: 97 },
        { format: "balanced", extensions: false, payloadType: 97 },
    ];
    windows.forEach((window, index) => {
        const timer = setTimeout(() => {
            try {
                const result = independent.setVideoFormat(window.format, window.extensions, window.payloadType);
                notify("video-format-cycle", { ...window, window: index + 2, at: new Date().toISOString(), ...result });
                console.log(new Date().toISOString(), "video-format-cycle", index + 2,
                    window.format, "ext", window.extensions, "pt", window.payloadType);
            } catch (error) {
                notify("independent-error", { message: `Đổi format video lỗi: ${error.message}` });
            }
        }, (index + 1) * 20000);
        formatCycleTimers.push(timer);
    });
    notify("video-format-cycle", { format: "nal", extensions: false, payloadType: 97, window: 1, at: new Date().toISOString(), active: true });
    console.log(new Date().toISOString(), "video-format-cycle", 1, "nal", "ext", false, "pt", 97);
}
/** Send the native camera-state notification for the active call. */
async function publishCameraState(enabled) {
    if (zalo.state !== "online") return { signalSent: false, reason: "offline" };
    const call = independent.activeCall();
    if (!call) return { signalSent: false, reason: "no-call" };
    const result = await zalo.sendCallCameraState(call.uidN, String(call.callId),
        { isOnCam: enabled ? 1 : 0, isOnMic: -1 });
    const responseCode = result.responseCode ?? null;
    // The native client treats the /conf HTTP outcome as authoritative: a
    // non-zero error_code means the peer never received onoff_camera.
    if (typeof responseCode === "number" && responseCode !== 0) {
        notify("independent-error", { message: `Zalo từ chối trạng thái camera (mã ${responseCode})` });
        notify("independent-camera-signal", { enabled: Boolean(enabled), signalSent: false, responseCode });
        return { ...result, signalSent: false };
    }
    lastCameraState = { enabled: Boolean(enabled), responseCode, at: new Date().toISOString() };
    notify("independent-camera-signal", { enabled: Boolean(enabled), signalSent: result.signalSent === true, responseCode });
    return result;
}
const independent = new IndependentCall(notify);
independent.onVideoKeyFrameRequest = mediaSsrc => notify("independent-video-pli", { requestKeyFrame: true, mediaSsrc });
const terminalCallActions = new Set(["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"]);
const zalo = new ZaloSession(notify, () => null, () => false, { onControl: event => {
    independent.observe(event);
    if (event.act === "answer" && independent.outgoing?.stage === "answer-received") {
        const callId = independent.outgoing.callId;
        const calleeId = independent.outgoing.calleeId;
        try {
            independent.prepareOutgoingAnswer();
            zalo.acknowledgeOutgoingAnswer(calleeId, callId)
                .then(() => independent.confirmOutgoingAnswer(callId))
                .catch(error => notify("independent-error", { message: `Caller chưa ACK được answer: ${error.message}` }));
        } catch (error) { notify("independent-error", { message: `Caller media answer chưa sẵn sàng: ${error.message}` }); }
    }
    if (event.act === "request" && independent.status().offerParsed) {
        notify("independent-relay-starting", { automatic: true });
        const registration = independent.registerRelay();
        notify("independent-state", independent.status());
        registration.catch(error => {
            notify("independent-error", { message: `Relay tự kết nối thất bại: ${error.message}` });
            notify("independent-state", independent.status());
        });
    }
    if (terminalCallActions.has(event.act)) stopMedia().catch(() => {});
} });
async function listAudioDevices() { return []; }
async function stopMedia() {
    if (media?.mode === "zalo") independent.onDecodedPcm = null;
    media?.close(); media = null; owner = null; mediaInput = undefined;
}
function snapshot() {
    return {
        helper: "removed",
        independent: independent.status(),
        zalo: zalo.state,
        active: Boolean(media && !media.closed),
        mode: media?.mode,
        stats: lastStats,
        devices,
        nativeBuilt: false,
        liveVerified: false,
        processTapAvailable: false,
        cameraState: lastCameraState,
        clientVideoStats: lastClientVideoStats,
        log: log.slice(-20),
    };
}
const server = http.createServer((request, response) => {
    const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!expectedHosts.has(request.headers.host)) {
        response.writeHead(403).end("Unsupported host");
        return;
    }
    if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/status") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(snapshot()));
        return;
    }
    if (url.pathname === "/api/config") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ iceServers }));
        return;
    }
    const assets = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/simple": ["simple.html", "text/html; charset=utf-8"],
        "/simple/": ["simple.html", "text/html; charset=utf-8"],
        "/main.js": ["main.js", "text/javascript"],
        "/main.css": ["main.css", "text/css"],
        "/main.js.map": ["main.js.map", "application/json"],
        "/simple.js": ["simple.js", "text/javascript"],
        "/simple.css": ["simple.css", "text/css"],
        "/simple.js.map": ["simple.js.map", "application/json"],
        "/simple.css.map": ["simple.css.map", "application/json"],
        "/call-flow": ["call-flow.html", "text/html; charset=utf-8"],
    };
    const asset = assets[url.pathname];
    if (!asset) {
        response.writeHead(404).end();
        return;
    }
    const file = path.join(directory, "dist", asset[0]);
    if (!fs.existsSync(file)) {
        response.writeHead(503).end("Build the demo: npm run build");
        return;
    }
    response.setHeader("Content-Type", asset[1]);
    fs.createReadStream(file).pipe(response);
});
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== "/ws" || !allowedOrigins.has(origin)) {
        socket.destroy();
        return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit("connection", ws));
});
wsServer.on("connection", (ws) => {
    peers.add(ws);
    ws.send(JSON.stringify({ event: "snapshot", data: snapshot() }));
    if (currentQr) ws.send(JSON.stringify({ event: "zalo-qr", data: currentQr }));
    let busy = false;
    ws.on("message", async (raw) => {
        // Encoded H.264 frames are a low-latency data path and must not wait behind
        // request/response RPC serialization. They stay in backend memory only.
        try {
            const fast = JSON.parse(raw.toString());
            if (fast?.action === "video-frame") {
                if (owner !== ws || !media || media.closed || media.mode !== "zalo") return;
                const encoded = fast.data?.frame;
                const timestamp = fast.data?.timestamp;
                if (typeof encoded !== "string" || encoded.length > 12 * 1024 * 1024 || !Number.isInteger(timestamp)) return;
                const frame = Buffer.from(encoded, "base64");
                if (!frame.length || frame.length > 8 * 1024 * 1024) return;
                try { independent.sendBrowserVideoFrame(Uint8Array.from(frame), timestamp, fast.data?.keyFrame === true); }
                catch (error) { notify("independent-error", { message: `Video frame bị từ chối: ${error.message}` }); }
                return;
            }
        } catch { /* ordinary RPC path reports malformed requests below */ }
        if (busy) {
            let request;
            try {
                request = JSON.parse(raw.toString());
            } catch {
                return;
            }
            ws.send(JSON.stringify({ id: request.id, ok: false, error: "Previous operation is still running" }));
            return;
        }
        let id, action, outgoingFlow;
        try {
            const request = JSON.parse(raw.toString());
            if (request.event === "video-client-stats" && !request.action) {
                lastClientVideoStats = { ...request.data, at: new Date().toISOString() };
                notify("independent-video-client-stats", lastClientVideoStats);
                busy = false;
                return;
            }
            id = request.id;
            busy = true;
            ({ action } = request);
            const { data = {} } = request;
            outgoingFlow = action === "call-outgoing-preflight" ? "preflight"
                : action === "call-outgoing-invite" ? "invite" : undefined;
            if (outgoingFlow) notify("outgoing-call-stage", { flow: outgoingFlow, stage: "rpc-received" });
            let result = {};
            if (action === "devices") result = await listAudioDevices();
            else if (action === "helper-start" || action === "helper-stop") {
                throw new Error("ZaloCall đã được bỏ khỏi backend hiện tại");
            } else if (action === "media-offer") {
                if (owner && owner !== ws && media && !media.closed)
                    throw new Error("Another browser owns the audio session");
                if (data.mode === "zalo" && !independent.status().browserBridgeAvailable)
                    throw new Error("Cần relay đã đăng ký và codec/SRTP RTP sẵn sàng trước khi mở cầu audio");
                await stopMedia();
                if (!["tone", "echo", "zalo"].includes(data.mode)) throw new Error("Unknown independent audio mode");
                media = new MediaSession({
                    mode: data.mode,
                    iceServers,
                    ...(data.mode === "zalo" ? { relayBridge: {
                        onMicPcm: samples => { try { independent.sendBrowserPcm(samples); } catch (error) { notify("independent-error", { message: error.message }); } },
                    } } : {}),
                    notify,
                });
                mediaInput = data.input === "mic" ? "mic" : "tone";
                if (data.mode === "zalo") independent.onDecodedPcm = samples => media?.pushPcm(samples);
                owner = ws;
                try { result = await media.answer(data.offer); }
                catch (error) { if (data.mode === "zalo") independent.onDecodedPcm = null; throw error; }
            } else if (action === "media-stop") {
                if (owner && owner !== ws) throw new Error("Another browser owns the audio session");
                await stopMedia();
            } else if (action === "zalo-login") {
                await zalo.login();
            } else if (action === "zalo-reconnect") {
                zalo.reconnect();
            } else if (action === "zalo-logout") {
                await stopMedia();
                independent.clear(); zalo.logout();
            } else if (action === "call-probe") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                result = await independent.probe();
            } else if (action === "zalo-friends") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                result = await zalo.listFriends();
            } else if (action === "call-outgoing-preflight") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                if (independent.activeCall()) throw new Error("Đang có cuộc gọi khác; kết thúc cuộc gọi đó trước");
                result = await zalo.requestOutgoingCall(String(data.calleeId || ""), undefined,
                    preflight => independent.registerOutgoingRelay(preflight, String(data.calleeId || ""), Number(data.callType || 1)), Number(data.callType || 1));
            } else if (action === "call-outgoing-invite") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                if (owner !== ws || !media || media.closed || media.mode !== "zalo")
                    throw new Error("Bắt đầu audio trình duyệt ở mode Zalo trước khi gửi lời mời");
                if (mediaInput !== "mic") throw new Error("Chọn microphone và nối lại audio trước khi gọi bạn");
                const call = independent.activeCall();
                if (!call || call.direction !== "outgoing" || call.uidN !== String(data.calleeId || ""))
                    throw new Error("Chuẩn bị caller relay cho đúng người bạn trước");
                const payload = independent.buildOutgoingRequest();
                independent.beginOutgoingRequest();
                try {
                    result = await zalo.requestOutgoingMedia(payload);
                    independent.markOutgoingRequestSent();
                } catch (error) {
                    independent.rollbackOutgoingRequest();
                    throw error;
                }
            } else if (action === "call-relay-connect") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                result = await independent.registerRelay();
            } else if (action === "video-pli") {
                independent.sendVideoPli();
                result = { sent: true };
            } else if (action === "video-format") {
                result = independent.setVideoFormat(String(data.format || ""),
                    typeof data.extensions === "boolean" ? data.extensions : undefined,
                    typeof data.payloadType === "number" ? data.payloadType : undefined);
            } else if (action === "video-camera") {
                result = await publishCameraState(data.enabled !== false);
            } else if (action === "call-accept") {
                if (zalo.state !== "online") throw new Error("Kết nối tài khoản Zalo trước");
                if (owner !== ws || !media || media.closed || media.mode !== "zalo")
                    throw new Error("Chuẩn bị audio trình duyệt ở chế độ Zalo trước khi thử answer");
                const answer = independent.buildAcceptedAnswer();
                independent.beginAnswerSignal();
                try {
                    result = await zalo.answerIndependent(answer);
                    independent.markAnswerSignalSent();
                } catch (error) {
                    independent.rollbackAnswerSignal();
                    throw error;
                }
            } else if (action === "call-end") {
                await stopMedia();
                const call = independent.activeCall();
                const signal = call && zalo.state === "online"
                    ? call.direction === "outgoing" && call.stage !== "confirmed"
                        ? zalo.cancelOutgoingCall(call.uidN, String(call.callId), call.callType ?? 1)
                        : zalo.endCall(call.uidN, String(call.callId))
                    : Promise.resolve({ signalSent: false, localAudioStopped: true });
                // Stop media and close the relay immediately; do not keep the mic route or UDP socket alive
                // while waiting for the HTTP signaling service.
                independent.clear(true);
                result = await signal;
            } else if (action === "call-make") {
                throw new Error("Chưa có media engine Zalo độc lập hoàn chỉnh; không gửi tín hiệu giả đã nhận/kết thúc cuộc gọi");
            } else throw new Error("Unknown action");
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok: true, data: result }));
        } catch (error) {
            if (outgoingFlow) {
                const details = safeCallError(error);
                notify("outgoing-call-error", { flow: outgoingFlow, stage: "backend", ...details });
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok: false, error: details.message }));
            } else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok: false, error: error.message }));
        } finally {
            busy = false;
        }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
        peers.delete(ws);
        if (owner === ws) stopMedia().catch(() => {});
    });
});
server.listen(port, host, () => console.log(`ZCA Call Lab: http://localhost:${port}`));
async function shutdown() {
    credentialInput?.close();
    if (process.stdin.isTTY && process.argv.includes("--credential-stdin")) {
        try {
            execFileSync("stty", ["echo", "icanon"], { stdio: "inherit" });
        } catch {
            /* Terminal may already be closed. */
        }
        process.stdin.pause();
    }
    await stopMedia();
    zalo.logout();
    for (const peer of peers) peer.close();
    wsServer.close();
    server.close();
    global.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    global.gc?.();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Explicit operator-only input: never persist credentials or accept them in URLs.
if (process.argv.includes("--credential-stdin")) {
    if (process.stdin.isTTY) execFileSync("stty", ["-echo", "-icanon", "min", "1", "time", "0"], { stdio: "inherit" });
    const input = createInterface({ input: process.stdin, terminal: false });
    credentialInput = input;
    console.log("Ready for credentials JSON on stdin (input hidden; not saved).");
    input.once("line", async (line) => {
        input.close();
        if (process.stdin.isTTY) execFileSync("stty", ["echo", "icanon"], { stdio: "inherit" });
        let credentials;
        try {
            if (line.length > 128 * 1024) throw new Error("Input too large");
            credentials = JSON.parse(line);
            line = "";
            const result = await zalo.loginCredentials(credentials);
            console.log(JSON.stringify({ event: "credential-login-result", ...result }));
        } catch {
            console.log(JSON.stringify({ event: "credential-login-result", connected: false, inputError: true }));
        } finally {
            if (credentials) {
                credentials.cookie = [];
                credentials.imei = "";
                credentials.userAgent = "";
            }
        }
    });
}
