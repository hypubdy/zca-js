import { test } from "node:test";
import assert from "node:assert/strict";
import { ZaloCallClient } from "../src/index.js";

class FakeTrack {
    kind = "audio";
    enabled = true;
    stopped = false;
    stop() {
        this.stopped = true;
    }
}

class FakeStream {
    constructor() {
        this.track = new FakeTrack();
    }
    getTracks() {
        return [this.track];
    }
    getAudioTracks() {
        return [this.track];
    }
}

class FakePeerConnection {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription = null;
    closed = false;
    addTrack() {}
    async createOffer() {
        return { type: "offer", sdp: "test-offer" };
    }
    async setLocalDescription(offer) {
        this.localDescription = { ...offer, toJSON: () => offer };
    }
    async setRemoteDescription(answer) {
        this.remoteDescription = answer;
    }
    close() {
        this.closed = true;
    }
}

class FakeAudioContext {
    destination = {};
    async resume() {}
    createGain() {
        return { gain: { value: 1 }, connect() {} };
    }
    createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
    }
    async close() {}
}

class FakeAudio {
    async play() {}
    pause() {}
}

class FakeWebSocket {
    static OPEN = 1;
    static responder = null;
    readyState = 0;
    sent = [];
    constructor(url) {
        this.url = url;
        FakeWebSocket.instance = this;
        queueMicrotask(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.onopen?.();
        });
    }
    send(raw) {
        const request = JSON.parse(raw);
        this.sent.push(request);
        const data = FakeWebSocket.responder?.(request) ?? {};
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, data }) }));
    }
    event(event, data = {}) {
        this.onmessage?.({ data: JSON.stringify({ event, data }) });
    }
    close() {
        this.readyState = 3;
        this.onclose?.();
    }
}

function createClient(overrides = {}) {
    const stream = new FakeStream();
    const client = new ZaloCallClient({
        gatewayUrl: "ws://127.0.0.1:4317/ws",
        WebSocket: FakeWebSocket,
        RTCPeerConnection: FakePeerConnection,
        AudioContext: FakeAudioContext,
        Audio: FakeAudio,
        mediaDevices: { getUserMedia: async () => stream },
        fetch: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
        autoReconnect: false,
        ...overrides,
    });
    return { client, stream };
}

test("call performs preflight, media negotiation and invite in order", async () => {
    const { client, stream } = createClient();
    FakeWebSocket.responder = (request) =>
        request.action === "call-outgoing-preflight"
            ? { callId: "100", callerRelayRegistered: true }
            : request.action === "media-offer"
              ? { type: "answer", sdp: "test-answer" }
              : {};
    await client.connect();

    const result = await client.call("42");

    assert.equal(result.preflight.callId, "100");
    assert.deepEqual(
        FakeWebSocket.instance.sent.map((item) => item.action),
        ["call-outgoing-preflight", "media-offer", "call-outgoing-invite"],
    );
    assert.equal(client.getSnapshot().call, "inviting");

    FakeWebSocket.instance.event("independent-outgoing-ringing", { callId: "100" });
    assert.equal(client.getSnapshot().call, "ringing");
    FakeWebSocket.instance.event("independent-confirmed", { callId: "100", direction: "outgoing" });
    assert.equal(client.getSnapshot().call, "connected");

    await client.hangup();
    assert.equal(client.getSnapshot().call, "idle");
    assert.equal(stream.track.stopped, true);
    assert.equal(FakeWebSocket.instance.sent.at(-1).action, "call-end");
    client.destroy();
});

test("answer registers relay before opening media and accepting", async () => {
    const { client } = createClient();
    FakeWebSocket.responder = (request) =>
        request.action === "media-offer" ? { type: "answer", sdp: "test-answer" } : {};
    await client.connect();
    FakeWebSocket.instance.event("incoming-control", { action: "request" });

    assert.equal(client.getSnapshot().call, "incoming");
    await client.answer();

    assert.deepEqual(
        FakeWebSocket.instance.sent.map((item) => item.action),
        ["call-relay-connect", "media-offer", "call-accept"],
    );
    assert.equal(client.getSnapshot().call, "answering");
    client.destroy();
});

test("browser fetch keeps the global receiver during incoming media setup", async () => {
    let fetchCalled = false;
    const { client } = createClient({
        fetch: function () {
            assert.equal(this, globalThis);
            fetchCalled = true;
            return Promise.resolve({ ok: true, json: async () => ({ iceServers: [] }) });
        },
    });
    FakeWebSocket.responder = (request) =>
        request.action === "media-offer" ? { type: "answer", sdp: "test-answer" } : {};
    await client.connect();
    FakeWebSocket.instance.event("incoming-control", { action: "request" });

    await client.answer();

    assert.equal(fetchCalled, true);
    client.destroy();
});

test("incoming video offer diagnostics are exposed to UI state", () => {
    const { client } = createClient();
    client.handleEvent("independent-offer", { videoRequested: true, callType: 1, videoCodecId: 1 });
    assert.equal(client.getSnapshot().independent.offerDiagnostics.videoRequested, true);
    assert.equal(client.getSnapshot().independent.offerDiagnostics.videoCodecId, 1);
    client.destroy();
});
test("sends encoded H264 frames over the low-latency gateway path", async () => {
    const { client } = createClient();
    await client.connect();
    client.sendVideoFrame(Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2]), 90000);
    const packet = FakeWebSocket.instance.sent.at(-1);
    assert.equal(packet.action, "video-frame");
    assert.equal(packet.data.timestamp, 90000);
    assert.equal(packet.data.frame, "AAAAAWUBAg==");
    client.destroy();
});

test("remote keyframe requests affect the camera, local PLI acknowledgements do not", () => {
    const { client } = createClient();
    let requested = 0;
    client.videoCapture = { requestKeyFrame: () => requested++ };
    client.handleEvent("independent-video-pli", { sent: true });
    assert.equal(requested, 0);
    client.handleEvent("independent-video-pli", { requestKeyFrame: true, mediaSsrc: 7 });
    assert.equal(requested, 1);
    client.videoCapture = null;
    client.destroy();
});

test("camera-state snapshot and notifications reach client diagnostics", async () => {
    const { client } = createClient();
    FakeWebSocket.responder = () => ({});
    await client.connect();
    FakeWebSocket.instance.event("snapshot", {
        zalo: "online",
        independent: {},
        cameraState: { enabled: true, at: "2026-10-25T00:00:00.000Z" },
    });
    assert.equal(client.getSnapshot().cameraState.enabled, true);
    FakeWebSocket.instance.event("independent-camera-signal", { enabled: false, signalSent: true });
    assert.deepEqual(client.getSnapshot().cameraState, { enabled: false, signalSent: true });
    client.destroy();
});
