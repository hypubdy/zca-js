// Starter wiring test with a fake Zalo client (no network, no QR).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBackend } from "../backend.mjs";

function fakeZalo(signals) {
    const listener = new EventEmitter();
    listener.start = () => setImmediate(() => listener.emit("connected"));
    listener.stop = () => {};
    const voiceCall = new Proxy({}, { get: (_, name) => async (...args) => { signals.push([name, ...args]); return {}; } });
    const api = { listener, voiceCall, getContext: () => ({ uid: "1" }), getAllFriends: async () => [{ userId: "42", displayName: "Peer" }] };
    return { api, client: { loginQR: async (_options, callback) => { callback({ type: 0, data: { image: "QR" }, actions: { abort() {} } }); return api; } } };
}

const request = (video = false, id = 9) => ({ act_type: "voip", act: "request", data: { uidFrom: "1", uidTo: "2", uidN: "300", ts: 1,
    params: JSON.stringify({ id, sessId: "x".repeat(40), rtpIP: "192.0.2.1:4200", rtcpIP: "192.0.2.1:4200",
        codec: JSON.stringify([{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }]),
        extendData: JSON.stringify({ srtpMode: 1, srtcp: 0, packetMode: 2, callType: video ? 1 : 0 }), zrtc_config: { srtpMode: 1, packetMode: 2 } }) } });

test("login → online → incoming → reject; video ignored", async () => {
    const events = [], signals = [];
    const { api, client } = fakeZalo(signals);
    const backend = createBackend({ publish: (event, data) => events.push([event, data]), createZalo: () => client });
    await backend.handle("zalo.login");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(backend.snapshot().zalo, "online");
    assert.ok(events.some(([e]) => e === "zalo-qr"));
    assert.deepEqual(await backend.handle("friends.list"), [{ id: "42", name: "Peer" }]);

    api.listener.emit("call", request(true));
    assert.deepEqual(events.find(([e]) => e === "call-unsupported")[1], { peerId: "300", callId: "9", kind: "video" });

    api.listener.emit("call", request(false, 10));
    const incoming = events.find(([e]) => e === "call-incoming")[1];
    assert.equal(incoming.peerId, "300");
    await backend.handle("call.reject");
    assert.equal(events.find(([e]) => e === "call-ended")[1].reason, "rejected");
    assert.ok(signals.some(([name, payload]) => name === "answer" && payload.status === 3));
    await assert.rejects(backend.handle("call.dial", { peerId: "not-a-uid" }), /numeric/);
    await backend.close();
});
