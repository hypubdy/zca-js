// Video contract tests for zca-js/call (run against dist/: `bun run build && npm run test:call`).
// Fake api/listener/relay; real SRTP + H.264 RTP packetization on the "peer" side.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCallController } from "zca-js/call";
import { experimentalCallProtocol as proto } from "zca-js";

const SESSION = "S".repeat(20) + "secret-session-value";
const RELAY_IP = "192.0.2.77";
const PEER_UID = "200000000000000001";
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function harness({ video = true, answerVideo = true, noVideoRelay = false, ...extra } = {}) {
    const listener = new EventEmitter();
    const signals = [];
    const relays = [];
    const voiceCall = {
        ring: async (...a) => { signals.push(["ring", ...a]); return {}; },
        answer: async p => { signals.push(["answer", p]); return {}; },
        answerAck: async (...a) => { signals.push(["answerAck", ...a]); return {}; },
        requestCall: async p => {
            signals.push(["requestCall", p]);
            return { id: Number(p.callId), status: 0, fromId: -12, toId: 34, protocol: 3, sessId: SESSION,
                zrtc_config: { srtpMode: 1, packetMode: 2 },
                servers: [{ rtpaddr: `${RELAY_IP}:4200`, rtcpaddr: `${RELAY_IP}:4200`, relayTime: 1 }] };
        },
        request: async p => { signals.push(["request", p]); return {}; },
        cancel: async (...a) => { signals.push(["cancel", ...a]); return {}; },
        end: async (...a) => { signals.push(["end", ...a]); return {}; },
        sendOnOffCamMic: async p => { signals.push(["conf", p]); return { error_code: 0 }; },
    };
    const openRelay = async (init, endpoint, handlers) => {
        const relay = {
            init, relay: endpoint, handlers, audio: [], rtcp: [], video: [], videoRtcp: [], camera: [], closed: null,
            sendAudio(b) { this.audio.push(Uint8Array.from(b)); },
            sendAudioRtcp(b) { this.rtcp.push(Uint8Array.from(b)); },
            sendVideo(b) { this.video.push(Uint8Array.from(b)); },
            sendVideoRtcp(b) { this.videoRtcp.push(Uint8Array.from(b)); },
            sendLocalCameraState(on) { this.camera.push(["local", on]); },
            sendVideoSuspend(s) { this.camera.push(["suspend", s]); },
            close(sendEnd = true) { if (this.closed === null) this.closed = { sendEnd }; },
        };
        if (noVideoRelay) { delete relay.sendVideo; delete relay.sendVideoRtcp; }
        relays.push(relay);
        return relay;
    };
    const controller = createCallController({ api: { voiceCall }, listener, openRelay, video, videoPacing: false, ...extra });
    const control = (act, data) => listener.emit("call", { act_type: "voip", act, data });
    const answerFor = callId => ({ callId: Number(callId), status: 0, params: JSON.stringify({ platform: 2,
        codec: JSON.stringify([{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }]),
        extendData: JSON.stringify(answerVideo
            ? { srtpMode: 1, srtcp: 0, packetMode: 2, callType: 1, video: { codec: [{ name: "h264", payload: 97 }] } }
            : { srtpMode: 1, srtcp: 0, packetMode: 2, callType: 0 }) }) });
    return { listener, controller, signals, relays, control, answerFor };
}

function videoOffer(id = 42) {
    return {
        uidFrom: "123456", uidTo: "987654", uidN: PEER_UID, ts: 1,
        params: JSON.stringify({
            id, sessId: SESSION, rtpIP: `${RELAY_IP}:4200`, rtcpIP: `${RELAY_IP}:4200`,
            codec: JSON.stringify([{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }]),
            extendData: JSON.stringify({ srtpMode: 1, srtcp: 0, packetMode: 2, callType: 1,
                video: { codec: [{ name: "h264", payload: 97 }] } }),
            zrtc_config: { srtpMode: 1, packetMode: 2 },
        }),
    };
}

/** Annex-B IDR access unit: SPS, PPS, and a large IDR slice (forces FU-A). */
function keyFrameAu(size = 4000) {
    const sps = [0x67, 0x42, 0xe0, 0x1e, 0x8d, 0x68, 0x14, 0x1f];
    const pps = [0x68, 0xce, 0x3c, 0x80];
    const idr = new Uint8Array(size); idr[0] = 0x65;
    for (let i = 1; i < size; i++) idr[i] = (i * 7 + 3) & 0xff || 1;
    return Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]);
}
function deltaFrameAu() { return Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a, 0x22, 0x33, 0x44]); }

async function connectIncomingVideo(h) {
    const seen = new Promise(resolve => h.controller.once("incoming", resolve));
    h.control("request", videoOffer());
    const call = await seen;
    await call.answer();
    h.control("answerack", { callId: 42 });
    assert.equal(call.state, "connected");
    return call;
}

test("video: offers stay ignored unless createCallController({ video: true })", async () => {
    const h = harness({ video: false });
    const unsupported = [];
    h.controller.on("incoming-unsupported", info => unsupported.push(info));
    h.control("request", videoOffer(77));
    await tick();
    assert.deepEqual(unsupported, [{ peerId: PEER_UID, callId: "77", kind: "video" }]);
    await h.controller.destroy();
});

test("video incoming: answer advertises H.264, /conf camera-on after ACK, frames both ways", async () => {
    const h = harness();
    const call = await connectIncomingVideo(h);
    assert.equal(call.video, true);
    const answer = h.signals.find(s => s[0] === "answer")[1];
    const ext = JSON.parse(answer.extendData);
    assert.equal(ext.callType, 1);
    assert.deepEqual(ext.video.codec, [{ name: "h264", payload: 97 }]);
    await tick();
    assert.deepEqual(h.signals.find(s => s[0] === "conf")[1], { calleeId: PEER_UID, callId: "42", isOnCam: 1, isOnMic: -1, data: "" });
    const relay = h.relays[0];
    assert.deepEqual(relay.camera, [["local", true], ["suspend", false]]);
    assert.ok(relay.videoRtcp.length >= 1, "PLI sent at start to get the peer's first IDR");

    // Our → peer: a delta frame before any keyframe is dropped.
    assert.equal(call.writeVideo(deltaFrameAu(), { timestamp90k: 0, keyFrame: false }), 0);
    const au = keyFrameAu();
    const sent = call.writeVideo(au, { timestamp90k: 3000, keyFrame: true });
    assert.ok(sent >= 4, `IDR split across packets (got ${sent})`);
    assert.equal(relay.video.length, sent);
    const key = proto.selectZrtcSrtpKey(1, SESSION, "");
    const first = new DataView(relay.video[0].buffer);
    assert.equal(first.getUint32(8), 987654, "video SSRC is the local call user id");
    assert.ok(relay.video.every(p => (p[1] & 0x7f) === 98), "keyframe AU on the ZaloCall key payload type 98");
    const unprotect = new proto.SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "receive", ssrc: 987654,
        initialRoc: 0, initialSequenceNumber: first.getUint16(2) });
    const clear = relay.video.map(p => proto.parseRtpPacket(unprotect.unprotect(p)));
    assert.ok(clear.at(-1).marker, "marker on the last packet of the AU");
    assert.ok(clear.slice(0, -1).every(p => !p.marker));
    // packetMode 2 default = "balanced", as Zalo Desktop 26.11.10 sends live:
    // the whole Annex-B AU split into equal raw chunks, start code only on the first.
    assert.deepEqual([...clear[0].payload.subarray(0, 5)], [0, 0, 0, 1, 0x67], "balanced: AU starts with the SPS start code");
    const sizes = clear.map(p => p.payload.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `balanced chunk sizes ${sizes}`);
    assert.deepEqual(Buffer.concat(clear.map(p => p.payload)), Buffer.from(au), "raw chunks concatenate to the AU");

    // Peer → our: packetize the same AU like a packetMode-2 Zalo Desktop peer (balanced raw).
    const frames = [];
    call.on("video", f => frames.push(f));
    const packetizer = new proto.H264RtpPacketizer({ payloadType: 97, ssrc: 123456, initialSequenceNumber: 500, packetization: "zrtp" });
    const protect = new proto.SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "send", ssrc: 123456, initialRoc: 0, initialSequenceNumber: 500 });
    for (const ts of [9000, 12000]) // the AU completes when the next timestamp starts
        for (const packet of packetizer.packetize(ts === 9000 ? au : keyFrameAu(300), ts))
            relay.handlers.onMedia({ kind: "video", payload: protect.protect(packet) });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].keyFrame, true);
    assert.equal(frames[0].timestamp, 9000);
    assert.deepEqual(proto.splitH264Nals(frames[0].data).map(n => n[0] & 0x1f), [7, 8, 5]);
    const stats = call.stats().video;
    assert.equal(stats.framesSent, 1);
    assert.equal(stats.keyFramesSent, 1);
    assert.equal(stats.framesReceived, 1);
    assert.equal(call.diagnostics().videoNegotiated, true);

    // Camera off → /conf isOnCam 0 and outgoing frames dropped.
    call.setCameraEnabled(false);
    await tick();
    assert.equal(h.signals.filter(s => s[0] === "conf").at(-1)[1].isOnCam, 0);
    assert.equal(call.writeVideo(au, { timestamp90k: 6000, keyFrame: true }), 0);
    await call.hangup();
    assert.equal(call.writeVideo(au, { timestamp90k: 9000, keyFrame: true }), 0);
    await h.controller.destroy();
});

test("video incoming: peer PLI emits keyframe-request; onoff_camera updates remote camera", async () => {
    const h = harness();
    const call = await connectIncomingVideo(h);
    const requests = [], camera = [];
    call.on("keyframe-request", () => requests.push(1));
    call.on("remote-camera", on => camera.push(on));
    const pli = proto.buildCompoundRtcpPli(123456, 987654, "peer");
    h.relays[0].handlers.onMedia({ kind: "videoRtcp", token: 0, payload: Uint8Array.from(pli) });
    assert.equal(requests.length, 1);
    h.control("onoff_camera", { callId: 42, params: JSON.stringify({ type: 1, isOnCam: 0 }) });
    h.control("onoff_camera", { callId: 42, params: JSON.stringify({ type: 1, isOnCam: 1 }) });
    assert.deepEqual(camera, [false, true]);
    assert.equal(call.stats().video.remoteCameraOff, false);
    await h.controller.destroy();
});

test("video outgoing: requestcall typeRequest 3, request callType 1, video negotiated from answer", async () => {
    const h = harness();
    const call = await h.controller.dial(PEER_UID, { video: true });
    assert.equal(call.video, true);
    assert.equal(h.signals.find(s => s[0] === "requestCall")[1].typeRequest, 3);
    const request = h.signals.find(s => s[0] === "request")[1];
    const ext = JSON.parse(request.extendData);
    assert.equal(ext.callType, 1);
    assert.deepEqual(ext.video.codec, [{ name: "h264", payload: 97 }]);
    assert.deepEqual(request.video, { enable: 1 }, "native callers arm the callee video leg");
    h.control("answer", h.answerFor(call.id));
    await tick(5);
    assert.equal(call.state, "connected");
    assert.equal(call.diagnostics().videoNegotiated, true);
    assert.ok(call.writeVideo(keyFrameAu(), { timestamp90k: 1, keyFrame: true }) > 0);
    const relay = h.relays[0];
    assert.equal(new DataView(relay.video[0].buffer).getUint32(8), 0xfffffff4, "caller video SSRC = fromId as uint32");
    await call.hangup();
    assert.deepEqual(h.signals.at(-1), ["end", PEER_UID, call.id]);
    await h.controller.destroy();
});

test("video outgoing: peer answering audio-only keeps the call audio-only", async () => {
    const h = harness({ answerVideo: false });
    const call = await h.controller.dial(PEER_UID, { video: true });
    h.control("answer", h.answerFor(call.id));
    await tick(5);
    assert.equal(call.state, "connected");
    assert.equal(call.diagnostics().videoNegotiated, false);
    assert.equal(call.writeVideo(keyFrameAu(), { timestamp90k: 1, keyFrame: true }), 0);
    await h.controller.destroy();
});

test("video outgoing: cancel before answer uses callType 3", async () => {
    const h = harness();
    const call = await h.controller.dial(PEER_UID, { video: true });
    await call.hangup();
    assert.deepEqual(h.signals.at(-1), ["cancel", PEER_UID, call.id, 3]);
    await h.controller.destroy();
});

test("video outgoing: videoRequestEnable false omits params.video; voice dial never sends it", async () => {
    const h = harness({ videoRequestEnable: false });
    const call = await h.controller.dial(PEER_UID, { video: true });
    assert.equal(h.signals.find(s => s[0] === "request")[1].video, undefined);
    await call.hangup();
    const voice = harness();
    const audio = await voice.controller.dial(PEER_UID);
    assert.equal(voice.signals.find(s => s[0] === "request")[1].video, undefined);
    await audio.hangup();
    await h.controller.destroy(); await voice.controller.destroy();
});

test("video incoming: relay without video support answers audio-only", async () => {
    const h = harness({ noVideoRelay: true });
    await connectIncomingVideo(h);
    const answer = h.signals.find(s => s[0] === "answer")[1];
    const ext = JSON.parse(answer.extendData);
    assert.notEqual(ext.callType, 1);
    assert.equal(ext.video, undefined);
    await h.controller.destroy();
});

test("video: delta frames use the negotiated PT 97, keyframes the paired PT 98", async () => {
    const h = harness();
    const call = await connectIncomingVideo(h);
    const relay = h.relays[0];
    call.writeVideo(keyFrameAu(), { timestamp90k: 1, keyFrame: true });
    const keyCount = relay.video.length;
    call.writeVideo(deltaFrameAu(), { timestamp90k: 3000, keyFrame: false });
    assert.ok(relay.video.slice(0, keyCount).every(p => (p[1] & 0x7f) === 98));
    assert.ok(relay.video.slice(keyCount).every(p => (p[1] & 0x7f) === 97));
    await h.controller.destroy();
});

test("video: peer PLI does not stall delta frames; camera status codes are not camera state", async () => {
    const h = harness();
    const call = await connectIncomingVideo(h);
    assert.ok(call.writeVideo(keyFrameAu(), { timestamp90k: 1, keyFrame: true }) > 0);
    const pli = proto.buildCompoundRtcpPli(123456, 987654, "peer");
    h.relays[0].handlers.onMedia({ kind: "videoRtcp", token: 0, payload: Uint8Array.from(pli) });
    assert.ok(call.writeVideo(deltaFrameAu(), { timestamp90k: 3000, keyFrame: false }) > 0, "delta still sent after PLI");
    const camera = [];
    call.on("remote-camera", on => camera.push(on));
    h.control("onoff_camera", { callId: 42, status: 0, params: JSON.stringify({ type: 1 }) });
    assert.deepEqual(camera, []);
    await h.controller.destroy();
});

test("video: pacing sends large AUs in bursts, small frames immediately, all in order", async () => {
    const h = harness({ videoPacing: true });
    const call = await connectIncomingVideo(h);
    const relay = h.relays[0];
    const sent = call.writeVideo(keyFrameAu(30000), { timestamp90k: 1, keyFrame: true });
    assert.ok(sent > 8, `keyframe packets ${sent}`);
    assert.equal(relay.video.length, 4, "first burst only");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(relay.video.length, sent, "rest drained by the pacer");
    const seq = relay.video.map(p => new DataView(p.buffer, p.byteOffset).getUint16(2));
    assert.ok(seq.every((s, i) => i === 0 || s === ((seq[i - 1] + 1) & 0xffff)), "sequence order preserved");
    await h.controller.destroy();
});
