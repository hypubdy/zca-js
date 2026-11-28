import fs from "node:fs";
import path from "node:path";
// Call backend built ONLY on the public API: zca-js (login), zca-js/call, zca-js/call-webrtc.
import { Zalo } from "zca-js";
import { createCallController } from "zca-js/call";
import { createWebRtcBridge } from "zca-js/call-webrtc";

const VERBOSE = process.env.CALL_DEBUG === "1";
const logger = {
    debug: (m, meta) => { if (VERBOSE) console.debug(m, meta ?? ""); },
    info: (m, meta) => console.info(m, meta ?? ""),
    warn: (m, meta) => console.warn(m, meta ?? ""),
    error: (m, meta) => console.error(m, meta ?? ""),
};

function describeCall(call) {
    if (!call) return null;
    return { id: call.id, peerId: call.peerId, direction: call.direction, state: call.state, video: call.video, stats: call.stats() };
}

/** Binary video frame on WS /video: [flags u8 (bit0 = keyframe)][timestamp90k u32 BE][H.264 Annex-B AU]. */
function encodeVideoFrame(frame) {
    const out = Buffer.allocUnsafe(5 + frame.data.length);
    out[0] = frame.keyFrame ? 1 : 0;
    out.writeUInt32BE(frame.timestamp >>> 0, 1);
    out.set(frame.data, 5);
    return out;
}

/**
 * @param {{ publish(event: string, data?: object): void, iceServers?: object[], createZalo?: () => any }} options
 */
export function createBackend({ publish, iceServers = [], createZalo = () => new Zalo({ checkUpdate: false, logging: false, selfListen: false }) }) {
    let zaloState = "offline";
    let api = null;
    let controller = null;
    let bridge = null;
    let statsTimer = null;
    let abortLogin = null;
    let generation = 0;
    const videoSockets = new Set();
    const toVideoSockets = message => {
        for (const ws of videoSockets) {
            // Drop frames for a slow browser instead of buffering unboundedly.
            if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(message);
        }
    };

    const setZalo = (state, extra = {}) => { zaloState = state; publish("zalo-state", { state, ...extra }); };

    function watchCall(call) {
        call.on("state", state => publish("call-state", describeCall(call) ?? { state }));
        call.on("error", error => publish("call-error", { code: error.code, message: error.message }));
        call.on("remote-mute", muted => publish("call-remote-mute", { muted }));
        if (call.video) {
            // CALL_DUMP_VIDEO=<dir>: append received Annex-B AUs to <dir>/<callId>.h264 for offline decode checks.
            const dump = process.env.CALL_DUMP_VIDEO
                ? fs.createWriteStream(path.join(process.env.CALL_DUMP_VIDEO, `${call.id}.h264`)) : null;
            call.on("video", frame => { dump?.write(frame.data); toVideoSockets(encodeVideoFrame(frame)); });
            call.once("ended", () => dump?.end());
            // Peer's decoder lost sync: ask the browser encoder for an IDR.
            call.on("keyframe-request", () => toVideoSockets(JSON.stringify({ type: "keyframe" })));
            call.on("remote-camera", on => publish("call-remote-camera", { on }));
        }
        // CALL_DEBUG: dump video counters (no keys/IPs; diagnostics() is redacted) to the server log.
        const debugVideo = label => {
            if (!process.env.CALL_DEBUG || !call.video) return;
            const d = call.diagnostics();
            console.log(`[call] ${label}`, { video: call.stats().video, ...Object.fromEntries(Object.entries(d).filter(([k]) => /^video/.test(k))) });
        };
        let debugTicks = 0;
        call.once("ended", info => {
            debugVideo("video final");
            publish("call-ended", { ...info, id: call.id, peerId: call.peerId, diagnostics: call.diagnostics() });
            clearInterval(statsTimer); statsTimer = null;
        });
        clearInterval(statsTimer);
        statsTimer = setInterval(() => {
            if (call.state === "ended") return;
            publish("call-stats", { ...call.stats(), diagnostics: call.diagnostics() });
            if (++debugTicks % 5 === 0) debugVideo("video stats");
        }, 1000);
        if (bridge) bridge.attach(call);
    }

    async function startController() {
        await controller?.destroy();
        controller = createCallController({ api, listener: api.listener, logger, sendRinging: true, video: true,
            videoPacketFormat: process.env.VIDEO_PACKETIZATION || undefined,
            videoRequestEnable: process.env.VIDEO_REQUEST_ENABLE !== "0" });
        controller.on("incoming", call => {
            watchCall(call);
            publish("call-incoming", describeCall(call));
        });
        controller.on("incoming-unsupported", info => publish("call-unsupported", info));
    }

    function attachApi(newApi) {
        api = newApi;
        const listener = api.listener;
        listener.on("connected", () => {
            if (api !== newApi) return;
            setZalo("online", { uid: String(api.getContext().uid) });
            // Contract: destroy the old controller and create a new one on (re)connect.
            void startController();
        });
        // The controller itself ends the active call ("network") on these events.
        listener.on("disconnected", code => { if (api === newApi) setZalo("disconnected", { code }); });
        listener.on("closed", code => { if (api === newApi) setZalo("offline", { code }); });
        listener.on("error", () => publish("zalo-error", { message: "Zalo listener error" }));
        listener.start({ retryOnClose: true });
    }

    function requireController() {
        if (!controller || zaloState !== "online") throw new Error("Zalo is not connected");
        return controller;
    }
    function requireCall() {
        const call = controller?.active();
        if (!call) throw new Error("No active call");
        return call;
    }

    return {
        async handle(action, data = {}) {
            switch (action) {
                case "zalo.login": {
                    if (["connecting", "online"].includes(zaloState)) return { state: zaloState };
                    const current = ++generation;
                    setZalo("connecting");
                    createZalo().loginQR({}, event => {
                        if (event.actions?.abort) abortLogin = event.actions.abort;
                        if (current !== generation) { event.actions?.abort?.(); return; }
                        if (event.type === 0) publish("zalo-qr", { image: event.data.image });
                        if (event.type === 2) setZalo("scanned");
                        if (event.type === 1 || event.type === 3) { setZalo("offline", { message: "QR expired or declined" }); event.actions?.abort?.(); }
                        // Never forward login info (cookies/IMEI) anywhere.
                    }).then(newApi => {
                        if (current !== generation) { newApi.listener.stop(); return; }
                        attachApi(newApi);
                    }).catch(() => { if (current === generation) setZalo("offline", { message: "Login failed" }); });
                    return { state: "connecting" };
                }
                case "zalo.logout": {
                    generation++;
                    try { abortLogin?.(); } catch { /* finished */ }
                    await controller?.destroy(); controller = null;
                    api?.listener.stop(); api = null;
                    setZalo("offline");
                    return { state: "offline" };
                }
                case "friends.list": {
                    if (!api || zaloState !== "online") throw new Error("Zalo is not connected");
                    const users = await api.getAllFriends(200, 1);
                    return (Array.isArray(users) ? users : []).map(user => ({
                        id: String(user?.userId ?? ""), name: String(user?.displayName || user?.zaloName || user?.userId || ""),
                    })).filter(user => /^\d+$/.test(user.id) && user.name);
                }
                case "media.negotiate": {
                    bridge?.close();
                    bridge = createWebRtcBridge({ iceServers });
                    bridge.on("state", state => publish("bridge-state", { state }));
                    const answer = await bridge.accept(data.offer);
                    const call = controller?.active();
                    if (call) bridge.attach(call);
                    return answer;
                }
                case "media.close": { bridge?.close(); bridge = null; return { closed: true }; }
                case "call.dial": {
                    const call = await requireController().dial(String(data.peerId || ""), { video: data.video === true });
                    watchCall(call);
                    publish("call-state", describeCall(call));
                    return describeCall(call);
                }
                case "call.answer": {
                    const call = requireCall();
                    // Voice-only answer of a video call: tell the peer our camera is off.
                    if (data.camera === false) call.setCameraEnabled(false);
                    await call.answer();
                    return describeCall(call);
                }
                case "call.reject": { const call = requireCall(); await call.reject(); return describeCall(call); }
                case "call.hangup": { const call = controller?.active(); await call?.hangup(); return { ended: true }; }
                case "call.mute": { requireCall().setMuted(Boolean(data.muted)); return { muted: Boolean(data.muted) }; }
                case "call.camera": { requireCall().setCameraEnabled(Boolean(data.enabled)); return { enabled: Boolean(data.enabled) }; }
                default: throw new Error("Unsupported action");
            }
        },
        /** WS /video: browser → binary encoded frames / {"type":"pli"}; backend → remote frames / {"type":"keyframe"}. */
        attachVideoSocket(ws) {
            videoSockets.add(ws);
            ws.on("close", () => videoSockets.delete(ws));
            ws.on("message", (message, isBinary) => {
                const call = controller?.active();
                if (!call || call.state !== "connected") return;
                if (!isBinary) {
                    try { if (JSON.parse(String(message)).type === "pli") call.requestKeyFrame(); } catch { /* ignore */ }
                    return;
                }
                const bytes = message instanceof Buffer ? message : Buffer.concat(message);
                if (bytes.length < 6) return;
                try { call.writeVideo(bytes.subarray(5), { timestamp90k: bytes.readUInt32BE(1), keyFrame: (bytes[0] & 1) === 1 }); }
                catch (error) { publish("call-error", { code: error.code, message: error.message }); }
            });
        },
        snapshot() {
            return { zalo: zaloState, call: describeCall(controller?.active() ?? null), bridge: bridge?.connectionState ?? null };
        },
        async close() {
            clearInterval(statsTimer);
            await controller?.destroy();
            bridge?.close();
            api?.listener.stop();
        },
    };
}
