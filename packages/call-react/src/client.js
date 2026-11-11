import { defaultOptions, initialState, TERMINAL_ACTIONS } from "./constants.js";
import { CallMediaSession } from "./media.js";
import { CallStore, restoreIncoming } from "./store.js";
import { assertCallTransport, GatewayTransport, transportRequest } from "./transport.js";
import { configUrl, websocketUrl } from "./urls.js";
import { createVideoCapture, createVideoDecoder, stopVideoCapture } from "./video.js";

/** Browser call state/media client. Application authentication is external. */
export class ZaloCallClient {
    constructor(options = {}) {
        this.options = { ...defaultOptions, ...options, mediaConstraints: options.mediaConstraints ?? defaultOptions.mediaConstraints };
        this.deps = {
            RTCPeerConnection: options.RTCPeerConnection || globalThis.RTCPeerConnection,
            MediaStream: options.MediaStream || globalThis.MediaStream,
            AudioContext: options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext,
            mediaDevices: options.mediaDevices || globalThis.navigator?.mediaDevices,
            Audio: options.Audio || globalThis.Audio,
            VideoEncoder: options.VideoEncoder || globalThis.VideoEncoder,
            MediaStreamTrackProcessor: options.MediaStreamTrackProcessor || globalThis.MediaStreamTrackProcessor,
            EncodedVideoChunk: options.EncodedVideoChunk || globalThis.EncodedVideoChunk,
            VideoDecoder: globalThis.VideoDecoder,
        };
        this.fetchImpl = (options.fetch || globalThis.fetch)?.bind(globalThis);
        this.store = new CallStore(initialState);
        this.videoCapture = null; this.videoDecoder = null; this.mediaSession = null;
        this.videoStats = { received: 0, decoded: 0, errors: 0, lastError: null };
        this.videoStatsTimer = null; this.lastVideoPliAt = 0; this.operation = null;
        this.customTransport = Boolean(options.transport);
        this.transport = this.customTransport
            ? assertCallTransport(options.transport)
            : new GatewayTransport({ url: websocketUrl(this.options.gatewayUrl), rpcTimeoutMs: this.options.rpcTimeoutMs,
                reconnectMs: this.options.reconnectMs, autoReconnect: this.options.autoReconnect,
                WebSocketImpl: options.WebSocket || globalThis.WebSocket, onStatus: (patch) => this.update(patch),
                onEvent: (event, data) => this.handleEvent(event, data), onClose: () => this.closeMedia() });
        this.unsubscribeTransport = this.transport.subscribe((message) => {
            if (typeof message === "string") this.handleEvent(message, {});
            else if (message?.type) { const { type, ...data } = message; this.handleEvent(type, data); }
        });
    }
    get state() { return this.store.state; }
    get socket() { return this.transport.socket; }
    set socket(value) { this.transport.socket = value; }
    getSnapshot = () => this.store.getSnapshot();
    subscribe = (listener) => this.store.subscribe(listener);
    onEvent = (listener) => this.store.onEvent(listener);
    update(patch) { this.store.update(patch); }
    emit(event, data) { this.store.emit(event, data); }
    async connect() {
        if (this.transport.connect) {
            await this.transport.connect();
            this.update({ gateway: "connected", error: null });
            return;
        }
        this.update({ gateway: "connected", error: null });
    }
    disconnect() {
        this.closeMedia(); this.transport.disconnect?.();
        this.update({ gateway: "disconnected", call: "idle", direction: null, media: "idle" });
    }
    destroy() { this.disconnect(); this.unsubscribeTransport?.(); this.unsubscribeTransport = null; this.store.clear(); }
    rpc(action, data = {}) { return transportRequest(this.transport, action, data); }
    request(action, data = {}) { return transportRequest(this.transport, action, data); }
    async ensureConnected() { if (this.transport.connect && !this.transport.isOpen) await this.connect(); }

    handleEvent(event, data = {}) {
        if (event === "zalo-state") this.update({ zalo: data.state || "offline", qr: ["online", "offline", "expired"].includes(data.state) ? null : this.state.qr });
        else if (event === "zalo-qr") {
            const image = data.image || "";
            this.update({ qr: image.startsWith("data:") ? image : `data:image/png;base64,${image}` });
        } else if (event === "call-state") {
            const next = data.state || data.call || this.state.call;
            const allowed = ["idle", "incoming", "preparing", "calling", "ringing", "answering", "connecting", "connected", "ending", "ended", "error"];
            if (allowed.includes(next)) this.update({ call: next, direction: data.direction ?? this.state.direction, incoming: data.incoming ?? this.state.incoming, error: data.error ?? null });
        } else if (event === "call-incoming") this.update({ call: "incoming", direction: "incoming", incoming: data.call || data, error: null });
        else if (event === "snapshot") {
            const incoming = restoreIncoming(data.log);
            this.update({ zalo: data.zalo || this.state.zalo, incoming, ...(data.qr ? { qr: data.qr } : {}), ...(data.cameraState ? { cameraState: data.cameraState } : {}), ...(data.independent ? { independent: data.independent } : {}), ...(incoming ? { call: "incoming", direction: "incoming" } : {}) });
        } else if (event === "independent-video-client-stats") this.update({ videoClientStats: data });
        else if (event === "media-stats") this.update({ stats: data });
        else if (event === "independent-camera-signal") this.update({ cameraState: { enabled: data.enabled === true, signalSent: data.signalSent === true } });
        else if (event === "independent-video-frame") { this.videoStats.received++; this.reportVideoStatsSoon(); this.videoDecoder?.push(data); }
        else if (event === "independent-video-pli") { if (data.requestKeyFrame) this.videoCapture?.requestKeyFrame?.(); }
        else if (event === "independent-offer") this.update({ independent: { ...this.state.independent, offerDiagnostics: data } });
        else if (event === "incoming-control") {
            if (["request", "group_request"].includes(data.action)) this.update({ call: "incoming", direction: "incoming", incoming: { action: data.action, at: Date.now(), status: "ringing" }, error: null });
            else if (TERMINAL_ACTIONS.has(data.action)) { this.closeMedia(); this.update({ call: "idle", direction: null, incoming: null, media: "idle" }); }
        } else if (event === "outgoing-call-stage") {
            const call = data.stage === "caller-relay-ready" ? "relay-ready" : data.stage === "request-start" ? "inviting" : data.stage === "request-accepted" ? "calling" : this.state.call;
            this.update({ call });
        } else if (event === "independent-outgoing-ringing") this.update({ call: "ringing", direction: "outgoing" });
        else if (event === "independent-outgoing-answer") this.update({ call: data.status === 0 ? "connecting" : "ended" });
        else if (event === "independent-confirmed") { this.videoCapture?.requestKeyFrame?.(); this.update({ call: "connected" }); }
        else if (event === "media-state") this.update({ media: data.state || "unknown" });
        else if (event === "media-ended" || (event === "call-state" && data.state === "free")) { this.closeMedia(); this.update({ call: "idle", direction: null, incoming: null, media: "idle" }); }
        else if (["outgoing-call-error", "independent-error", "zalo-error", "call-error"].includes(event)) this.update({ call: "error", error: data.message || "Call failed" });
        this.emit(event, data);
    }
    runExclusive(operation) {
        if (this.operation) return Promise.reject(new Error("Another call operation is running"));
        const promise = Promise.resolve().then(operation); this.operation = promise;
        return promise.finally(() => { if (this.operation === promise) this.operation = null; });
    }
    requestVideoKeyFrame() {
        const now = Date.now(); if (now - this.lastVideoPliAt < 1000) return Promise.resolve({ sent: false });
        this.lastVideoPliAt = now; return this.rpc("media.request-keyframe");
    }
    call(peerId, { callType = 1 } = {}) {
        return this.runExclusive(async () => {
            if (!peerId) throw new Error("peerId is required");
            if (![1, 3].includes(callType)) throw new Error("callType must be 1 (audio) or 3 (video)");
            await this.ensureConnected(); this.update({ call: "preparing", direction: "outgoing", incoming: null, error: null });
            let prepared;
            try {
                prepared = await this.rpc("call.prepare", { peerId: String(peerId), mediaType: callType === 3 ? "video" : "audio" });
                await this.openMedia(); if (callType === 3) await this.startVideoCapture();
                this.update({ call: "inviting" });
                const started = await this.rpc("call.start", { peerId: String(peerId), mediaType: callType === 3 ? "video" : "audio", callId: prepared?.callId });
                return { preflight: prepared, invite: started };
            } catch (error) {
                this.closeMedia(); if (prepared) await this.rpc("call.end", { callId: prepared.callId }).catch(() => {});
                this.update({ call: "error", direction: null, media: "idle", error: error.message }); throw error;
            }
        });
    }
    answer() {
        return this.runExclusive(async () => {
            await this.ensureConnected(); this.update({ call: "answering", direction: "incoming", error: null });
            try {
                await this.rpc("call.prepare-media", { callId: this.state.incoming?.callId }); await this.openMedia();
                if (this.state.incoming?.offer?.videoRequested === true) await this.startVideoCapture();
                return await this.rpc("call.accept", { callId: this.state.incoming?.callId });
            } catch (error) {
                this.closeMedia(); await this.rpc("call.end", { callId: this.state.incoming?.callId }).catch(() => {});
                this.update({ call: "error", direction: null, media: "idle", error: error.message }); throw error;
            }
        });
    }
    hangup() {
        return this.runExclusive(async () => {
            this.update({ call: "ending" }); this.closeMedia();
            try { return await this.rpc("call.end", { callId: this.state.incoming?.callId }); }
            finally { this.update({ call: "idle", direction: null, incoming: null, media: "idle" }); }
        });
    }
    async openMedia() {
        if (this.mediaSession) return;
        this.mediaSession = await CallMediaSession.open({ rpc: (action, data) => this.rpc(action, data), fetchImpl: this.fetchImpl,
            configUrl: this.options.configUrl || (this.transport.url ? configUrl(null, this.transport.url) : undefined),
            mediaConstraints: this.options.mediaConstraints, iceTimeoutMs: this.options.iceTimeoutMs, deps: this.deps,
            onState: (patch) => this.update(patch), onError: (error) => this.update({ call: "error", error: error.message }) })
            .catch((error) => { this.mediaSession = null; throw error; });
    }
    setMicrophoneMuted(muted) { this.mediaSession?.setMicrophoneMuted(muted); }
    setPlaybackMuted(muted) { this.mediaSession?.setPlaybackMuted(muted); }
    setVolume(volume) { this.mediaSession?.setVolume(volume); }
    startVideoCapture(options = {}) {
        if (this.videoCapture) return Promise.resolve(this.videoCapture);
        return createVideoCapture({ deps: this.deps, isConfirmed: () => this.state.call === "connected",
            sendVideoFrame: (frame, timestamp90k, keyFrame) => this.sendVideoFrame(frame, timestamp90k, keyFrame),
            socketBufferedAmount: () => this.transport.socket?.bufferedAmount || 0, emit: (event, data) => this.emit(event, data), ...options })
            .then((capture) => { this.videoCapture = capture; return capture; });
    }
    async stopVideoCapture() { const capture = this.videoCapture; this.videoCapture = null; await stopVideoCapture(capture); }
    startVideoDecoder({ codec = "avc1.42E01E", onFrame } = {}) {
        this.videoDecoder?.close(); this.videoDecoder = createVideoDecoder({ deps: { VideoDecoder: this.deps.VideoDecoder, EncodedVideoChunk: this.deps.EncodedVideoChunk },
            stats: this.videoStats, onFrame, emit: (event, data) => this.emit(event, data), requestKeyFrame: () => this.requestVideoKeyFrame(), codec });
        return this.videoDecoder;
    }
    stopVideoDecoder() { this.videoDecoder?.close(); this.videoDecoder = null; }
    reportVideoStatsSoon() {
        if (this.videoStatsTimer) return;
        this.videoStatsTimer = setTimeout(() => {
            this.videoStatsTimer = null; if (!this.videoStats.received) return;
            if (this.customTransport) this.transport.request("media.stats", { ...this.videoStats }).catch(() => {});
            else this.transport.sendRaw({ event: "video-client-stats", data: { ...this.videoStats } });
        }, 1000);
    }
    sendVideoFrame(frame, timestamp90k, keyFrame = false) {
        if (!this.transport.sendRaw) throw new Error("Selected transport does not support video frames");
        if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 8 * 1024 * 1024) throw new RangeError("Encoded video frame must be 1..8388608 bytes");
        if (!Number.isInteger(timestamp90k) || timestamp90k < 0 || timestamp90k > 0xffffffff) throw new RangeError("Video RTP timestamp must be a uint32");
        let binary = ""; for (let offset = 0; offset < frame.length; offset += 0x8000) binary += String.fromCharCode(...frame.subarray(offset, Math.min(offset + 0x8000, frame.length)));
        this.transport.sendRaw({ action: "video-frame", data: { timestamp: timestamp90k, keyFrame, frame: btoa(binary) } });
    }
    closeMedia() {
        this.stopVideoCapture().catch(() => {}); this.videoDecoder?.reset();
        const session = this.mediaSession; this.mediaSession = null; session?.close();
    }
}
