import { ZaloSession } from "../backend/zalo-session.mjs";
import { IndependentCall } from "../backend/independent-call.mjs";
import { MediaSession } from "../backend/media.mjs";

/** The starter's single backend call runtime: ZCA-JS + UDP relay + WebRTC audio. */
export function createCallBackend({ publish, iceServers = [] }) {
    let media = null;
    let owner = null;
    let mediaInput = null;
    let lastStats = null;
    let lastClientVideoStats = null;
    let lastCameraState = null;
    const history = [];

    function notify(event, data = {}) {
        if (event === "media-stats") lastStats = data;
        if (event === "independent-camera-signal") lastCameraState = { ...data, at: new Date().toISOString() };
        if (event === "independent-video-frame") {
            if (owner?.readyState === 1 && owner.bufferedAmount < 1024 * 1024)
                owner.send(JSON.stringify({ event, data }));
            return;
        }
        publish(event, data);
        if (!new Set(["media-stats", "zalo-qr", "independent-media-diagnostics", "independent-state", "independent-video-media"]).has(event)) {
            history.push({ time: new Date().toISOString(), event, data });
            if (history.length > 80) history.shift();
        }
    }

    const independent = new IndependentCall(notify);
    const activeIncoming = () => independent.pending?.offer || null;
    independent.onVideoKeyFrameRequest = (mediaSsrc) => notify("independent-video-pli", { requestKeyFrame: true, mediaSsrc });
    const terminal = new Set(["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"]);
    let zalo;
    zalo = new ZaloSession(notify, () => null, () => false, {
        onControl: (event) => {
            independent.observe(event);
            if (event.act === "request" && independent.status().offerParsed) {
                const offer = independent.activeCall();
                publish("call-incoming", { direction: "incoming", mediaType: "audio", callId: offer?.callId, peerId: offer?.uidN, displayName: "Cuộc gọi thoại đến" });
                independent.registerRelay().then(() => notify("independent-state", independent.status()))
                    .catch((error) => notify("independent-error", { message: `Relay không đăng ký được: ${error.message}` }));
            }
            if (event.act === "answer" && independent.outgoing?.stage === "answer-received") {
                const { callId, calleeId } = independent.outgoing;
                try {
                    independent.prepareOutgoingAnswer();
                    zalo.acknowledgeOutgoingAnswer(calleeId, callId)
                        .then(() => independent.confirmOutgoingAnswer(callId))
                        .catch((error) => notify("independent-error", { message: `Không ACK được answer: ${error.message}` }));
                } catch (error) { notify("independent-error", { message: `Answer chưa sẵn sàng: ${error.message}` }); }
            }
            if (terminal.has(event.act)) void stopMedia();
        },
    });

    async function stopMedia() {
        if (media?.mode === "zalo") independent.onDecodedPcm = null;
        const previous = media;
        media = null; owner = null; mediaInput = null;
        previous?.close();
    }
    async function openBrowserMedia(socket, offer, mode = "zalo", input = "mic") {
        if (!socket || socket.readyState !== 1) throw new Error("Kênh media trình duyệt chưa kết nối");
        if (owner && owner !== socket && media && !media.closed) throw new Error("Đang có trình duyệt khác dùng audio");
        await stopMedia();
        media = new MediaSession({
            mode,
            iceServers,
            ...(mode === "zalo" ? { relayBridge: { onMicPcm(samples) {
                try { independent.sendBrowserPcm(samples); }
                catch (error) { notify("independent-error", { message: error.message }); }
            } } } : {}),
            notify,
        });
        mediaInput = input;
        if (mode === "zalo") independent.onDecodedPcm = (samples) => media?.pushPcm(samples);
        owner = socket;
        try { return await media.answer(offer); }
        catch (error) { await stopMedia(); throw error; }
    }

    return {
        async handle(action, data = {}, socket = null) {
            switch (action) {
                case "zalo.login": await zalo.login(); return { started: true };
                case "zalo.status": return { state: zalo.state };
                case "zalo.reconnect": zalo.reconnect(); return { reconnecting: true };
                case "zalo.logout": await stopMedia(); independent.clear(); zalo.logout(); return { loggedOut: true };
                case "friends.list": return zalo.listFriends();
                case "call.prepare": {
                    if (zalo.state !== "online") throw new Error("Zalo chưa kết nối");
                    if (independent.activeCall()) throw new Error("Đang có cuộc gọi khác; kết thúc trước khi gọi tiếp");
                    const peerId = String(data.peerId || "");
                    return zalo.requestOutgoingCall(peerId, undefined,
                        (preflight) => independent.registerOutgoingRelay(preflight, peerId, 1), 1);
                }
                case "media.negotiate": return openBrowserMedia(socket, data.offer, data.mode || "zalo", data.input || "mic");
                case "call.start": {
                    if (zalo.state !== "online") throw new Error("Zalo chưa kết nối");
                    publish("call-state", { state: "preparing", direction: "outgoing" });
                    if (owner !== socket || !media || media.closed || media.mode !== "zalo" || mediaInput !== "mic")
                        throw new Error("Microphone/WebRTC chưa nối vào relay; chưa gửi lời mời");
                    const call = independent.activeCall();
                    if (!call || call.direction !== "outgoing" || call.uidN !== String(data.peerId || ""))
                        throw new Error("Caller relay chưa được chuẩn bị cho đúng người nhận");
                    const payload = independent.buildOutgoingRequest();
                    independent.beginOutgoingRequest();
                    try {
                        const result = await zalo.requestOutgoingMedia(payload);
                        independent.markOutgoingRequestSent();
                        notify("call-state", { state: "calling", direction: "outgoing", callId: call.callId });
                        return result;
                    } catch (error) { independent.rollbackOutgoingRequest(); throw error; }
                }
                case "call.prepare-media": {
                    if (zalo.state !== "online") throw new Error("Zalo chưa kết nối");
                    return independent.registerRelay();
                }
                case "call.accept": {
                    if (zalo.state !== "online") throw new Error("Zalo chưa kết nối");
                    if (!activeIncoming()) throw new Error("Không có cuộc gọi đến");
                    if (owner !== socket || !media || media.closed || media.mode !== "zalo") throw new Error("Microphone/WebRTC chưa sẵn sàng");
                    const answer = independent.buildAcceptedAnswer();
                    independent.beginAnswerSignal();
                    try {
                        const result = await zalo.answerIndependent(answer);
                        independent.markAnswerSignalSent();
                        notify("call-state", { state: "answering", direction: "incoming" });
                        return result;
                    } catch (error) { independent.rollbackAnswerSignal(); throw error; }
                }
                case "call.end": {
                    await stopMedia();
                    const call = independent.activeCall();
                    const signal = call && zalo.state === "online"
                        ? call.direction === "outgoing" && call.stage !== "confirmed"
                            ? zalo.cancelOutgoingCall(call.uidN, String(call.callId), call.callType ?? 1)
                            : zalo.endCall(call.uidN, String(call.callId))
                        : Promise.resolve({ signalSent: false, localAudioStopped: true });
                    independent.clear(true);
                    publish("call-state", { state: "idle" });
                    return signal;
                }
                case "media.request-keyframe": independent.sendVideoPli(); return { sent: true };
                case "media.stats": lastClientVideoStats = { ...data, at: new Date().toISOString() }; return { received: true };
                default: throw new Error("Yêu cầu không được hỗ trợ");
            }
        },
        async clientDisconnected(socket) {
            if (owner === socket) { await stopMedia(); independent.clear(true); publish("call-state", { state: "idle" }); }
        },
        snapshot() {
            return { zalo: zalo.state, independent: independent.status(), active: Boolean(media && !media.closed), mode: media?.mode,
                stats: lastStats, clientVideoStats: lastClientVideoStats, cameraState: lastCameraState, log: history.slice(-20) };
        },
        async close() { await stopMedia(); independent.clear(); zalo.logout(); },
    };
}
