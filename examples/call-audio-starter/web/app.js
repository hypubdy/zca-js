/* global document, location, RTCPeerConnection, MediaStream, Option */
// Browser side: mic/speaker over WebRTC to the backend's zca-js/call-webrtc bridge,
// plus (video calls) WebCodecs H.264 over WS /video, see video.js.
import { startVideo, videoSupported } from "./video.js";

const $ = id => document.getElementById(id);
const state = { zalo: "offline", call: null, pc: null, stream: null, video: null, videoTimer: null };

function log(line) {
    const el = $("log");
    el.textContent = `${new Date().toLocaleTimeString()} ${line}\n${el.textContent}`.slice(0, 8000);
}
async function api(action, data = {}) {
    const res = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, data }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "Request failed");
    return body.data;
}
async function run(fn) {
    $("error").textContent = "";
    try { await fn(); } catch (error) { $("error").textContent = error.message; log(`error: ${error.message}`); }
}

/** Create (once per call) a browser PeerConnection with the mic and negotiate with the backend bridge. */
async function connectMedia() {
    closeMedia();
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const config = await (await fetch("/api/config")).json();
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    state.pc = pc;
    for (const track of state.stream.getAudioTracks()) pc.addTrack(track, state.stream);
    pc.ontrack = event => { $("remote").srcObject = event.streams[0] ?? new MediaStream([event.track]); };
    pc.onconnectionstatechange = () => log(`browser media: ${pc.connectionState}`);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
        if (pc.iceGatheringState === "complete") return resolve();
        const timer = setTimeout(resolve, 4000);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } });
    });
    const answer = await api("media.negotiate", { offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    await pc.setRemoteDescription(answer);
}
function closeMedia() {
    state.pc?.close(); state.pc = null;
    state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
    void stopVideoMedia();
}

async function startVideoMedia() {
    if (state.video) return;
    state.video = await startVideo({ localVideo: $("local-video"), canvas: $("remote-video"), log });
    $("videos").hidden = false;
    $("camera").checked = true;
    state.videoTimer = setInterval(() => {
        const v = state.video?.stats();
        if (v) $("video-stats").textContent = `video trình duyệt: encode ${v.encoded} · gửi ${v.sent} · nhận ${v.received} · hiện ${v.decoded} · lỗi decode ${v.decodeErrors}`;
    }, 1000);
}
async function stopVideoMedia() {
    clearInterval(state.videoTimer); state.videoTimer = null;
    const video = state.video; state.video = null;
    $("videos").hidden = true;
    await video?.stop();
}

function render() {
    $("login").hidden = state.zalo === "online";
    $("online").hidden = state.zalo !== "online";
    const call = state.call;
    const active = call && call.state !== "ended";
    $("status").textContent = `Zalo: ${state.zalo} · Cuộc gọi: ${active ? `${call.direction} ${call.state}` : "không có"}`;
    $("incoming").hidden = !(active && call.state === "incoming");
    $("incoming-peer").textContent = call?.peerId ?? "";
    $("incoming-kind").textContent = call?.video ? "Cuộc gọi video đến" : "Cuộc gọi đến";
    $("btn-answer-video").hidden = !call?.video;
    $("btn-answer-video").disabled = !videoSupported();
    $("btn-dial-video").disabled = Boolean(active) || !videoSupported();
    $("camera-wrap").hidden = !(active && call.video);
    $("btn-hangup").disabled = !active;
    $("btn-dial").disabled = Boolean(active);
}

function onEvent({ event, data }) {
    switch (event) {
        case "snapshot": state.zalo = data.zalo; state.call = data.call; break;
        case "zalo-state": state.zalo = data.state; if (data.state !== "connecting" && data.state !== "scanned") $("qr").hidden = true;
            if (data.state === "online") loadFriends(); break;
        case "zalo-qr": $("qr").src = data.image.startsWith("data:") ? data.image : `data:image/png;base64,${data.image}`; $("qr").hidden = false; break;
        case "call-incoming": state.call = data; log(`incoming from ${data.peerId}`); break;
        case "call-unsupported": log(`ignored ${data.kind} call from ${data.peerId} (answer it on your phone)`); break;
        case "call-state": state.call = data; log(`call ${data.state}`); break;
        case "call-ended": log(`ended: ${data.reason} (${Math.round(data.durationMs / 1000)}s) ${JSON.stringify(data.diagnostics)}`);
            state.call = { ...(state.call || {}), state: "ended" }; closeMedia(); break;
        case "call-stats": {
            const v = data.video;
            const videoLine = data.diagnostics?.video
                ? ` · video gửi ${v.framesSent} (${v.keyFramesSent} key) · nhận ${v.framesReceived} (${v.keyFramesReceived} key) · AU thiếu ${v.incompleteFrames}${data.diagnostics.videoNegotiated ? "" : " · peer KHÔNG nhận video"}${v.remoteCameraOff ? " · peer tắt camera" : ""}`
                : "";
            $("stats").textContent = `gửi ${data.packetsSent} · nhận ${data.packetsReceived} · mất ${data.packetsLost} · mic RMS ${data.inputRms.toFixed(4)} · loa RMS ${data.outputRms.toFixed(4)}${data.remoteMuted ? " · peer đang tắt mic" : ""}${videoLine}`;
            break;
        }
        case "call-remote-camera": log(`peer camera ${data.on ? "on" : "off"}`); break;
        case "call-remote-mute": log(`peer ${data.muted ? "muted" : "unmuted"}`); break;
        case "call-error": log(`call error ${data.code}: ${data.message}`); break;
        case "bridge-state": log(`bridge: ${data.state}`); break;
    }
    render();
}

async function loadFriends() {
    const friends = await api("friends.list").catch(() => []);
    $("friends").replaceChildren(new Option("— chọn bạn —", ""), ...friends.map(f => new Option(`${f.name} (${f.id})`, f.id)));
}

function connectEvents() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = message => onEvent(JSON.parse(message.data));
    ws.onclose = () => { $("status").textContent = "Mất kết nối backend, thử lại…"; setTimeout(connectEvents, 1500); };
}

$("btn-login").onclick = () => run(() => api("zalo.login"));
async function dial(video) {
    const peerId = $("friends").value;
    if (!peerId) throw new Error("Chọn một người bạn");
    await connectMedia();
    try {
        if (video) await startVideoMedia();
        state.call = await api("call.dial", { peerId, video });
    } catch (error) {
        closeMedia(); // no call-ended will arrive for a failed dial: release mic/camera now
        throw error;
    }
    render();
}
$("btn-dial").onclick = () => run(() => dial(false));
$("btn-dial-video").onclick = () => run(() => dial(true));
if (!videoSupported()) {
    const why = "Trình duyệt này không có WebCodecs/MediaStreamTrackProcessor — mở bằng Chrome hoặc Edge để gọi video";
    $("btn-dial-video").title = why; $("btn-answer-video").title = why;
    log(why);
}
// Answering a video call by voice only: the backend reports our camera as off (/conf isOnCam 0) and sends no frames.
$("btn-answer").onclick = () => run(async () => { await connectMedia(); await api("call.answer", { camera: false }); });
$("btn-answer-video").onclick = () => run(async () => { await connectMedia(); await startVideoMedia(); await api("call.answer"); });
$("camera").onchange = event => run(async () => {
    state.video?.setCamera(event.target.checked);
    await api("call.camera", { enabled: event.target.checked });
});
$("btn-reject").onclick = () => run(() => api("call.reject"));
$("btn-hangup").onclick = () => run(async () => { await api("call.hangup"); closeMedia(); });
$("mute").onchange = event => run(() => api("call.mute", { muted: event.target.checked }));

connectEvents();
render();
