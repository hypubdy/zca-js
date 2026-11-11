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
    return { id: call.id, peerId: call.peerId, direction: call.direction, state: call.state, stats: call.stats() };
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

    const setZalo = (state, extra = {}) => { zaloState = state; publish("zalo-state", { state, ...extra }); };

    function watchCall(call) {
        call.on("state", state => publish("call-state", describeCall(call) ?? { state }));
        call.on("error", error => publish("call-error", { code: error.code, message: error.message }));
        call.on("remote-mute", muted => publish("call-remote-mute", { muted }));
        call.once("ended", info => {
            publish("call-ended", { ...info, id: call.id, peerId: call.peerId, diagnostics: call.diagnostics() });
            clearInterval(statsTimer); statsTimer = null;
        });
        clearInterval(statsTimer);
        statsTimer = setInterval(() => {
            if (call.state === "ended") return;
            publish("call-stats", { ...call.stats(), diagnostics: call.diagnostics() });
        }, 1000);
        if (bridge) bridge.attach(call);
    }

    async function startController() {
        await controller?.destroy();
        controller = createCallController({ api, listener: api.listener, logger, sendRinging: true });
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
                    const call = await requireController().dial(String(data.peerId || ""));
                    watchCall(call);
                    publish("call-state", describeCall(call));
                    return describeCall(call);
                }
                case "call.answer": { const call = requireCall(); await call.answer(); return describeCall(call); }
                case "call.reject": { const call = requireCall(); await call.reject(); return describeCall(call); }
                case "call.hangup": { const call = controller?.active(); await call?.hangup(); return { ended: true }; }
                case "call.mute": { requireCall().setMuted(Boolean(data.muted)); return { muted: Boolean(data.muted) }; }
                default: throw new Error("Unsupported action");
            }
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
