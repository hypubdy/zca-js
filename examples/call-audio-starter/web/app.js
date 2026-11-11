/* global document, location, RTCPeerConnection, MediaStream, Option */
// Browser side: mic/speaker over WebRTC to the backend's zca-js/call-webrtc bridge.
const $ = id => document.getElementById(id);
const state = { zalo: "offline", call: null, pc: null, stream: null };

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
}

function render() {
    $("login").hidden = state.zalo === "online";
    $("online").hidden = state.zalo !== "online";
    const call = state.call;
    const active = call && call.state !== "ended";
    $("status").textContent = `Zalo: ${state.zalo} · Cuộc gọi: ${active ? `${call.direction} ${call.state}` : "không có"}`;
    $("incoming").hidden = !(active && call.state === "incoming");
    $("incoming-peer").textContent = call?.peerId ?? "";
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
        case "call-stats": $("stats").textContent = `gửi ${data.packetsSent} · nhận ${data.packetsReceived} · mất ${data.packetsLost} · mic RMS ${data.inputRms.toFixed(4)} · loa RMS ${data.outputRms.toFixed(4)}${data.remoteMuted ? " · peer đang tắt mic" : ""}`; break;
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
$("btn-dial").onclick = () => run(async () => {
    const peerId = $("friends").value;
    if (!peerId) throw new Error("Chọn một người bạn");
    await connectMedia();
    state.call = await api("call.dial", { peerId });
    render();
});
$("btn-answer").onclick = () => run(async () => { await connectMedia(); await api("call.answer"); });
$("btn-reject").onclick = () => run(() => api("call.reject"));
$("btn-hangup").onclick = () => run(async () => { await api("call.hangup"); closeMedia(); });
$("mute").onchange = event => run(() => api("call.mute", { muted: event.target.checked }));

connectEvents();
render();
