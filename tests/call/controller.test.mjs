// Contract tests for zca-js/call (run against the built dist/: `bun run build && npm run test:call`).
// No Zalo account or network: api, listener and UDP relay are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createCallController, CallError } from "zca-js/call";
import { experimentalCallProtocol as proto } from "zca-js";

const require = createRequire(import.meta.url);
const OpusScript = require("opusscript");

const SECRET_SESSION = "S".repeat(20) + "secret-session-value";
const RELAY_IP = "192.0.2.77";
const PEER_UID = "200000000000000001";

function makeHarness({ ringTimeoutMs = 60_000, sendRinging, connectTimeoutMs } = {}) {
    const listener = new EventEmitter();
    const signals = [];
    const relays = [];
    const logs = [];
    const voiceCall = {
        ring: async (...args) => { signals.push(["ring", ...args]); return {}; },
        answer: async (payload) => { signals.push(["answer", payload]); return {}; },
        answerAck: async (...args) => { signals.push(["answerAck", ...args]); return {}; },
        requestCall: async (payload) => {
            signals.push(["requestCall", payload]);
            return { id: Number(payload.callId), status: 0, fromId: -12, toId: 34, protocol: 3, sessId: SECRET_SESSION,
                zrtc_config: { srtpMode: 1, packetMode: 2 },
                servers: [{ rtpaddr: `${RELAY_IP}:4200`, rtcpaddr: `${RELAY_IP}:4200`, relayTime: 1 }] };
        },
        request: async (payload) => { signals.push(["request", payload]); return {}; },
        cancel: async (...args) => { signals.push(["cancel", ...args]); return {}; },
        end: async (...args) => { signals.push(["end", ...args]); return {}; },
    };
    const openRelay = async (init, endpoint, handlers) => {
        const relay = {
            init, relay: endpoint, handlers, audio: [], rtcp: [], closed: null,
            sendAudio(bytes) { this.audio.push(Uint8Array.from(bytes)); },
            sendAudioRtcp(bytes) { this.rtcp.push(Uint8Array.from(bytes)); },
            close(sendEnd = true) { if (this.closed === null) this.closed = { sendEnd }; },
        };
        relays.push(relay);
        return relay;
    };
    const logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level =>
        [level, (message, meta) => logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`)]));
    const controller = createCallController({ api: { voiceCall }, listener, logger, ringTimeoutMs, sendRinging,
        openRelay, connectTimeoutMs });
    const control = (act, data) => listener.emit("call", { act_type: "voip", act, data });
    return { listener, controller, signals, relays, logs, control };
}

function incomingRequest({ id = 42, video = false } = {}) {
    return {
        uidFrom: "123456", uidTo: "987654", uidN: PEER_UID, ts: 1,
        params: JSON.stringify({
            id, sessId: SECRET_SESSION, rtpIP: `${RELAY_IP}:4200`, rtcpIP: `${RELAY_IP}:4200`,
            codec: JSON.stringify([{ name: "opus/48000/2", payload: 113, frmPtime: 20, dynamicFptime: 0 },
                { name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }]),
            extendData: JSON.stringify({ srtpMode: 1, srtcp: 0, packetMode: 2, callType: video ? 1 : 0 }),
            zrtc_config: { srtpMode: 1, packetMode: 2 },
        }),
    };
}

function outgoingAnswer(callId, status = 0) {
    return { callId: Number(callId), status, params: JSON.stringify({ platform: 2,
        codec: JSON.stringify([{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }]),
        extendData: JSON.stringify({ srtpMode: 1, srtcp: 0, packetMode: 2 }) }) };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function track(call) {
    const states = [], ended = [];
    call.on("state", s => states.push(s));
    call.on("ended", info => ended.push(info));
    return { states, ended };
}

async function incomingCall(h, options) {
    const seen = new Promise(resolve => h.controller.once("incoming", resolve));
    h.control("request", incomingRequest(options));
    return seen;
}

async function connectIncoming(h) {
    const call = await incomingCall(h);
    const t = track(call);
    await call.answer();
    h.control("answerack", { callId: 42 });
    assert.equal(call.state, "connected");
    return { call, ...t };
}

async function connectOutgoing(h) {
    const call = await h.controller.dial(PEER_UID);
    const t = track(call);
    h.control("ringring", { callId: Number(call.id) });
    assert.equal(call.state, "ringing");
    h.control("answer", outgoingAnswer(call.id));
    await tick(5);
    assert.equal(call.state, "connected");
    return { call, ...t };
}

test("incoming: answer → ACK → connected → local hangup", async () => {
    const h = makeHarness();
    const { call, states, ended } = await connectIncoming(h);
    assert.equal(call.direction, "incoming");
    assert.equal(call.peerId, PEER_UID);
    assert.equal(call.id, "42");
    assert.deepEqual(states, ["connecting", "connected"]);
    const ring = h.signals.find(s => s[0] === "ring");
    assert.deepEqual(ring, ["ring", PEER_UID, "42"]);
    const answer = h.signals.find(s => s[0] === "answer")[1];
    assert.equal(answer.status, 0);
    assert.equal(answer.callerId, PEER_UID);
    assert.equal(JSON.parse(answer.codec)[0].payload, 113, "first supported offer codec is selected");
    assert.deepEqual(h.relays[0].init, { isCaller: false, userId: 987654, partnerId: 123456, callId: 42, sessionId: SECRET_SESSION, subcommand: 2 });
    await call.hangup();
    await call.hangup();
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, "local-hangup");
    assert.deepEqual(h.signals.at(-1), ["end", PEER_UID, "42"]);
    assert.deepEqual(h.relays[0].closed, { sendEnd: true });
    assert.equal(h.controller.active(), null);
    await h.controller.destroy();
});

test("incoming: remote endcall after connect → remote-hangup", async () => {
    const h = makeHarness();
    const { call, ended } = await connectIncoming(h);
    h.control("end_call", { callId: 42 });
    await tick();
    assert.deepEqual(ended.map(e => e.reason), ["remote-hangup"]);
    assert.equal(call.state, "ended");
    assert.ok(!h.signals.some(s => s[0] === "end"), "no endcall echoed for remote hangup");
    await h.controller.destroy();
});

test("incoming: reject sends decline status 3", async () => {
    const h = makeHarness();
    const call = await incomingCall(h);
    const { ended } = track(call);
    await call.reject();
    assert.deepEqual(ended.map(e => e.reason), ["rejected"]);
    const answer = h.signals.find(s => s[0] === "answer")[1];
    assert.equal(answer.status, 3);
    assert.equal(h.relays.length, 0, "no relay registered for a rejected call");
    await h.controller.destroy();
});

test("incoming: caller cancels before answer → cancelled", async () => {
    const h = makeHarness();
    const call = await incomingCall(h);
    const { ended } = track(call);
    h.control("cancel", { callId: 42 });
    await tick();
    assert.deepEqual(ended.map(e => e.reason), ["cancelled"]);
    assert.ok(!h.signals.some(s => ["answer", "cancel", "end"].includes(s[0])));
    await call.answer(); // no-op after ended
    await h.controller.destroy();
});

test("incoming: answered on another device → answered-elsewhere (provisional)", async () => {
    const h = makeHarness();
    const call = await incomingCall(h);
    const { ended } = track(call);
    h.control("answer", { callId: 42, status: 0 });
    await tick();
    assert.deepEqual(ended.map(e => e.reason), ["answered-elsewhere"]);
    await h.controller.destroy();
});

test("incoming: sendRinging=false suppresses ringring", async () => {
    const h = makeHarness({ sendRinging: false });
    await incomingCall(h);
    assert.ok(!h.signals.some(s => s[0] === "ring"));
    await h.controller.destroy();
});

test("incoming video: ignored, incoming-unsupported, no signaling", async () => {
    const h = makeHarness();
    const unsupported = [];
    let incoming = 0;
    h.controller.on("incoming-unsupported", info => unsupported.push(info));
    h.controller.on("incoming", () => incoming++);
    h.control("request", incomingRequest({ id: 77, video: true }));
    h.control("cancel", { callId: 77 });
    h.control("group_request", { callId: 78, uidN: "300" });
    assert.deepEqual(unsupported, [{ peerId: PEER_UID, callId: "77", kind: "video" }, { peerId: "300", callId: "78", kind: "group" }]);
    assert.equal(incoming, 0);
    assert.equal(h.signals.length, 0, "no ring/answer/reject for ignored calls");
    assert.equal(h.controller.active(), null);
    await h.controller.destroy();
});

test("outgoing: requestcall → relay → request → ringing → answer → ACK → connected → hangup", async () => {
    const h = makeHarness();
    const { call, states, ended } = await connectOutgoing(h);
    assert.deepEqual(states, ["ringing", "connecting", "connected"]);
    assert.deepEqual(h.signals.map(s => s[0]), ["requestCall", "request", "answerAck"]);
    const request = h.signals[1][1];
    assert.equal(request.calleeId, PEER_UID);
    assert.equal(JSON.parse(request.codec)[0].name, "opus/16000/1");
    assert.deepEqual(h.relays[0].init, { isCaller: true, userId: 0xfffffff4, partnerId: 34, callId: Number(call.id), sessionId: SECRET_SESSION, subcommand: 2 });
    assert.deepEqual(h.signals[2], ["answerAck", PEER_UID, call.id]);
    await call.hangup();
    assert.deepEqual(ended.map(e => e.reason), ["local-hangup"]);
    assert.deepEqual(h.signals.at(-1), ["end", PEER_UID, call.id]);
    await h.controller.destroy();
});

test("outgoing: hangup while ringing sends cancel", async () => {
    const h = makeHarness();
    const call = await h.controller.dial(PEER_UID);
    const { ended } = track(call);
    await call.hangup();
    assert.deepEqual(ended.map(e => e.reason), ["local-hangup"]);
    assert.deepEqual(h.signals.at(-1), ["cancel", PEER_UID, call.id, 1]);
    await h.controller.destroy();
});

test("outgoing: no answer within ringTimeoutMs → no-answer + cancel", async () => {
    const h = makeHarness({ ringTimeoutMs: 1000 });
    const call = await h.controller.dial(PEER_UID);
    const { ended } = track(call);
    await tick(1100);
    assert.deepEqual(ended.map(e => e.reason), ["no-answer"]);
    assert.deepEqual(h.signals.at(-1), ["cancel", PEER_UID, call.id, 1]);
    await h.controller.destroy();
});

test("outgoing: decline (status 3) → rejected; unknown status → error", async () => {
    const h = makeHarness();
    let call = await h.controller.dial(PEER_UID);
    let t = track(call);
    h.control("answer", outgoingAnswer(call.id, 3));
    await tick(5);
    assert.deepEqual(t.ended.map(e => e.reason), ["rejected"]);

    call = await h.controller.dial(PEER_UID);
    t = track(call);
    const errors = [];
    call.on("error", e => errors.push(e));
    h.control("answer", outgoingAnswer(call.id, 7));
    await tick(5);
    assert.deepEqual(t.ended.map(e => e.reason), ["error"]);
    assert.equal(errors[0].code, "zalo-rejected");
    assert.ok(h.logs.some(line => line.includes('"status":7')), "raw status is logged for live mapping");
    await h.controller.destroy();
});

test("outgoing: remote hangup after connect", async () => {
    const h = makeHarness();
    const { ended } = await connectOutgoing(h);
    h.control("endcall", {});
    await tick();
    assert.deepEqual(ended.map(e => e.reason), ["remote-hangup"]);
    await h.controller.destroy();
});

test("listener closed → network; next call works without restart", async () => {
    const h = makeHarness();
    const { ended } = await connectIncoming(h);
    h.listener.emit("closed", 1006, "");
    await tick();
    assert.deepEqual(ended.map(e => e.reason), ["network"]);
    assert.equal(h.controller.active(), null);
    const next = await h.controller.dial(PEER_UID);
    assert.equal(next.state, "dialing");
    await next.hangup();
    await h.controller.destroy();
});

test("busy / invalid peer / destroyed", async () => {
    const h = makeHarness();
    await assert.rejects(h.controller.dial("abc"), e => e instanceof CallError && e.code === "invalid-peer");
    const call = await h.controller.dial(PEER_UID);
    await assert.rejects(h.controller.dial(PEER_UID), e => e instanceof CallError && e.code === "busy");
    await assert.rejects(call.answer(), e => e.code === "invalid-state");
    await h.controller.destroy();
    assert.equal(call.state, "ended");
    await assert.rejects(h.controller.dial(PEER_UID), e => e.code === "invalid-state");
});

test("listener callback exceptions never escape", async () => {
    const h = makeHarness();
    h.controller.on("incoming", () => { throw new Error("app bug"); });
    assert.doesNotThrow(() => h.control("request", incomingRequest()));
    assert.doesNotThrow(() => h.listener.emit("call", null));
    assert.doesNotThrow(() => h.control("request", { params: "{not json" }));
    await h.controller.destroy();
});

test("remote mute_audio is reflected in stats", async () => {
    const h = makeHarness();
    const { call } = await connectIncoming(h);
    const mutes = [];
    call.on("remote-mute", m => mutes.push(m));
    h.control("mute_audio", { callId: 42 });
    assert.equal(call.stats().remoteMuted, true);
    h.control("mute_audio", { callId: 42, params: JSON.stringify({ isMute: 0 }) });
    assert.equal(call.stats().remoteMuted, false);
    assert.deepEqual(mutes, [true, false]);
    await h.controller.destroy();
});

test("destroy leaves no handles and no listener handlers", async () => {
    const before = process.getActiveResourcesInfo().filter(r => r === "Timeout").length;
    const h = makeHarness();
    const { call } = await connectOutgoing(h);
    call.writeAudio(new Int16Array(4800));
    await tick(50);
    await h.controller.destroy();
    await tick(5);
    assert.equal(h.listener.listenerCount("call"), 0);
    assert.equal(h.listener.listenerCount("closed"), 0);
    assert.equal(h.listener.listenerCount("disconnected"), 0);
    const after = process.getActiveResourcesInfo().filter(r => r === "Timeout").length;
    assert.ok(after <= before, `timers leaked: before=${before} after=${after}`);
    assert.ok(h.relays.every(r => r.closed), "relay closed");
});

test("logs and errors never contain session secrets or relay IPs", async () => {
    const h = makeHarness();
    await connectIncoming(h);
    await h.controller.active().hangup();
    await connectOutgoing(h);
    h.listener.emit("disconnected", 1006);
    await h.controller.destroy();
    const text = h.logs.join("\n");
    assert.ok(text.length > 0);
    assert.ok(!text.includes(SECRET_SESSION.slice(0, 20)), "session id leaked");
    assert.ok(!text.includes(RELAY_IP), "relay IP leaked");
});

// ----------------------------------------------------------------- media --

function sine(samples, rate, freq = 440, amplitude = 8000) {
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = Math.round(amplitude * Math.sin(2 * Math.PI * freq * i / rate));
    return pcm;
}
function rms(pcm) { let e = 0; for (const x of pcm) e += (x / 32768) ** 2; return pcm.length ? Math.sqrt(e / pcm.length) : 0; }

test("media: outgoing PCM is Opus/RTP/SRTP the peer can decrypt; inbound SRTP decodes to 48 kHz", async () => {
    const h = makeHarness();
    const { call } = await connectOutgoing(h);
    const relay = h.relays[0];
    const key = proto.selectZrtcSrtpKey(1, SECRET_SESSION, "");
    const localSsrc = 0xfffffff4, remoteSsrc = 34;

    // Our → peer: 300 ms of tone, written in odd-sized chunks.
    const tone = sine(48000 * 0.3, 48000);
    for (let i = 0; i < tone.length; i += 777) call.writeAudio(tone.subarray(i, i + 777));
    await tick(400);
    assert.ok(relay.audio.length >= 10, `expected ≥10 RTP packets, got ${relay.audio.length}`);
    const first = new DataView(relay.audio[0].buffer);
    assert.equal(first.getUint32(8), localSsrc, "RTP SSRC is the local call user id");
    assert.equal(relay.audio[0][1] & 0x7f, 112);
    const unprotect = new proto.SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "receive", ssrc: localSsrc,
        initialRoc: 0, initialSequenceNumber: first.getUint16(2) });
    const decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP, { wasm: true });
    let energy = 0, prevTs = null;
    for (const packet of relay.audio) {
        const rtp = proto.parseRtpPacket(unprotect.unprotect(packet));
        if (prevTs !== null) assert.equal((rtp.timestamp - prevTs) >>> 0, 320, "16 kHz clock, 20 ms step");
        prevTs = rtp.timestamp;
        const pcm = decoder.decode(Buffer.from(rtp.payload));
        energy = Math.max(energy, rms(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)));
    }
    decoder.delete();
    assert.ok(energy > 0.05, `peer hears the tone (rms ${energy})`);
    assert.ok(call.stats().inputRms > 0, "inputRms reflects written audio");

    // Peer → our: encrypt 20 frames of tone with the peer's SSRC.
    const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP, { wasm: true });
    const sender = new proto.RtpAudioSender({ ssrc: remoteSsrc, payloadType: 112, clockRate: 16000, timestampStep: 320, initialSequenceNumber: 1000 });
    const protect = new proto.SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "send", ssrc: remoteSsrc, initialRoc: 0, initialSequenceNumber: 1000 });
    const received = [];
    call.on("audio", pcm => received.push(pcm));
    const peerTone = sine(320 * 20, 16000);
    for (let f = 0; f < 20; f++) {
        const frame = Buffer.from(peerTone.buffer, f * 640, 640);
        const opus = encoder.encode(frame, 320);
        relay.handlers.onMedia({ kind: "audio", payload: protect.protect(sender.packet(Uint8Array.from(opus))) });
    }
    encoder.delete();
    assert.equal(received.length, 20);
    assert.equal(received[0].length, 960, "20 ms at 48 kHz");
    assert.ok(Math.max(...received.map(rms)) > 0.05);
    const stats = call.stats();
    assert.equal(stats.packetsReceived, 20);
    assert.ok(stats.packetsSent >= 10);
    assert.ok(stats.outputRms > 0);

    // Tampered packet is rejected, not decoded.
    const bad = protect.protect(sender.packet(new Uint8Array([0xf8, 0xff, 0xfe])));
    bad[bad.length - 1] ^= 1;
    relay.handlers.onMedia({ kind: "audio", payload: bad });
    assert.equal(call.stats().packetsReceived, 20);

    call.setMuted(true);
    await call.hangup();
    call.writeAudio(tone); // no-op after ended
    await h.controller.destroy();
});
