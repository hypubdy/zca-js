import { defaultOptions, initialState, TERMINAL_ACTIONS } from "./constants.js";
import { CallMediaSession } from "./media.js";
import { CallStore, restoreIncoming } from "./store.js";
import { GatewayTransport } from "./transport.js";
import { configUrl, websocketUrl } from "./urls.js";
import { createVideoCapture, createVideoDecoder, stopVideoCapture } from "./video.js";

/**
 * High-level Zalo call client for the browser.
 *
 * Responsibilities:
 *   - gateway transport (RPC + reconnection)      → transport.js
 *   - call state machine and event projection     → this.handleEvent
 *   - microphone, WebRTC and speaker playback     → media.js
 *   - camera capture and remote decoding          → video.js
 *
 * A React app normally uses the `useZaloCall` hook, or the `createZaloCall`
 * façade, and only calls `call(calleeId)` / `answer()` / `hangup()`.
 */
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
        const fetchImpl = options.fetch || globalThis.fetch;
        this.fetchImpl = fetchImpl?.bind(globalThis);
        this.store = new CallStore(initialState);
        this.videoCapture = null;
        this.videoDecoder = null;
        this.mediaSession = null;
        this.videoStats = { received: 0, decoded: 0, errors: 0, lastError: null };
        this.videoStatsTimer = null;
        this.lastVideoPliAt = 0;
        this.operation = null;
        this.transport = new GatewayTransport({
            url: websocketUrl(this.options.gatewayUrl),
            rpcTimeoutMs: this.options.rpcTimeoutMs,
            reconnectMs: this.options.reconnectMs,
            autoReconnect: this.options.autoReconnect,
            WebSocketImpl: options.WebSocket || globalThis.WebSocket,
            onStatus: (patch) => this.update(patch),
            onEvent: (event, data) => this.handleEvent(event, data),
            onClose: () => this.closeMedia(),
        });
    }

    get state() {
        return this.store.state;
    }

    /** Raw gateway socket, exposed for diagnostics and tests. */
    get socket() {
        return this.transport.socket;
    }

    set socket(value) {
        this.transport.socket = value;
    }

    getSnapshot = () => this.store.getSnapshot();

    subscribe = (listener) => this.store.subscribe(listener);

    onEvent = (listener) => this.store.onEvent(listener);

    update(patch) {
        this.store.update(patch);
    }

    emit(event, data) {
        this.store.emit(event, data);
    }

    async connect() {
        return this.transport.connect();
    }

    disconnect() {
        this.closeMedia();
        this.transport.disconnect();
    }

    destroy() {
        this.disconnect();
        this.store.clear();
    }

    rpc(action, data = {}) {
        return this.transport.rpc(action, data);
    }

    /** Connect on demand so callers never have to sequence connect() manually. */
    async ensureConnected() {
        if (!this.transport.isOpen) await this.connect();
    }

    handleEvent(event, data) {
        if (event === "snapshot") {
            const incoming = restoreIncoming(data.log);
            this.update({
                zalo: data.zalo || "offline",
                independent: data.independent || {},
                cameraState: data.cameraState || null,
                incoming,
                ...(incoming ? { call: "incoming", direction: "incoming" } : {}),
            });
        } else if (event === "independent-video-client-stats") {
            this.update({ videoClientStats: data });
        } else if (event === "media-stats") {
            this.update({ stats: data });
        } else if (event === "independent-camera-signal") {
            this.update({ cameraState: { enabled: data.enabled === true, signalSent: data.signalSent === true } });
        } else if (event === "zalo-state") {
            this.update({
                zalo: data.state || "offline",
                qr: ["online", "offline", "expired"].includes(data.state) ? null : this.state.qr,
            });
        } else if (event === "zalo-qr") {
            const image = data.image || "";
            this.update({ qr: image.startsWith("data:") ? image : `data:image/png;base64,${image}` });
        } else if (event === "independent-state") {
            this.update({ independent: { ...this.state.independent, ...data } });
        } else if (event === "independent-video-frame") {
            this.videoStats.received++;
            this.reportVideoStatsSoon();
            this.videoDecoder?.push(data);
        } else if (event === "independent-video-pli") {
            if (data.requestKeyFrame) this.videoCapture?.requestKeyFrame?.();
        } else if (event === "independent-offer") {
            this.update({ independent: { ...this.state.independent, offerDiagnostics: data } });
        } else if (event === "incoming-control") {
            if (["request", "group_request"].includes(data.action)) {
                this.update({
                    call: "incoming",
                    direction: "incoming",
                    incoming: { action: data.action, at: Date.now(), status: "ringing" },
                    error: null,
                });
            } else if (TERMINAL_ACTIONS.has(data.action)) {
                this.closeMedia();
                this.update({ call: "idle", direction: null, incoming: null, media: "idle" });
            }
        } else if (event === "outgoing-call-stage") {
            const call =
                data.stage === "caller-relay-ready"
                    ? "relay-ready"
                    : data.stage === "request-start"
                      ? "inviting"
                      : data.stage === "request-accepted"
                        ? "calling"
                        : this.state.call;
            this.update({ call });
        } else if (event === "independent-outgoing-ringing") {
            this.update({ call: "ringing", direction: "outgoing" });
        } else if (event === "independent-outgoing-answer") {
            this.update({ call: data.status === 0 ? "connecting" : "ended" });
        } else if (event === "independent-confirmed") {
            this.videoCapture?.requestKeyFrame?.();
            this.update({ call: "connected" });
        } else if (event === "media-state") {
            this.update({ media: data.state || "unknown" });
        } else if (event === "media-ended" || (event === "call-state" && data.state === "free")) {
            this.closeMedia();
            this.update({ call: "idle", direction: null, incoming: null, media: "idle" });
        } else if (["outgoing-call-error", "independent-error", "zalo-error"].includes(event)) {
            this.update({
                call: event === "zalo-error" ? this.state.call : "error",
                error: data.message || "Call failed",
            });
        }
        this.emit(event, data);
    }

    runExclusive(operation) {
        if (this.operation) return Promise.reject(new Error("Another call operation is running"));
        const promise = Promise.resolve().then(operation);
        this.operation = promise;
        return promise.finally(() => {
            if (this.operation === promise) this.operation = null;
        });
    }

    requestVideoKeyFrame() {
        const now = Date.now();
        if (now - this.lastVideoPliAt < 1000) return Promise.resolve({ sent: false });
        this.lastVideoPliAt = now;
        return this.rpc("video-pli");
    }

    /**
     * Place an outgoing call. Microphone and speaker playback are opened before
     * the invite is sent, so the remote party hears the caller immediately.
     */
    call(calleeId, { callType = 1 } = {}) {
        return this.runExclusive(async () => {
            if (!calleeId) throw new Error("calleeId is required");
            if (![1, 3].includes(callType)) throw new Error("callType must be 1 (audio) or 3 (video)");
            await this.ensureConnected();
            this.update({ call: "preparing", direction: "outgoing", incoming: null, error: null });
            let preflight;
            try {
                preflight = await this.rpc("call-outgoing-preflight", { calleeId: String(calleeId), callType });
                await this.openMedia();
                if (callType === 3) await this.startVideoCapture();
                this.update({ call: "inviting" });
                const invite = await this.rpc("call-outgoing-invite", { calleeId: String(calleeId), callType });
                return { preflight, invite };
            } catch (error) {
                this.closeMedia();
                if (preflight) await this.rpc("call-end").catch(() => {});
                this.update({ call: "error", direction: null, media: "idle", error: error.message });
                throw error;
            }
        });
    }

    /** Answer the current incoming call with microphone and playback ready. */
    answer() {
        return this.runExclusive(async () => {
            await this.ensureConnected();
            this.update({ call: "answering", direction: "incoming", error: null });
            try {
                await this.rpc("call-relay-connect");
                await this.openMedia();
                if (this.state.independent?.offerDiagnostics?.videoRequested === true) await this.startVideoCapture();
                return await this.rpc("call-accept");
            } catch (error) {
                this.closeMedia();
                await this.rpc("call-end").catch(() => {});
                this.update({ call: "error", direction: null, media: "idle", error: error.message });
                throw error;
            }
        });
    }

    hangup() {
        return this.runExclusive(async () => {
            this.update({ call: "ending" });
            this.closeMedia();
            try {
                return await this.rpc("call-end");
            } finally {
                this.update({ call: "idle", direction: null, incoming: null, media: "idle" });
            }
        });
    }

    async openMedia() {
        if (this.mediaSession) return;
        this.mediaSession = await CallMediaSession.open({
            rpc: (action, data) => this.rpc(action, data),
            fetchImpl: this.fetchImpl,
            configUrl: configUrl(this.options.configUrl, this.transport.url),
            mediaConstraints: this.options.mediaConstraints,
            iceTimeoutMs: this.options.iceTimeoutMs,
            deps: this.deps,
            onState: (patch) => this.update(patch),
            onError: (error) => this.update({ call: "error", error: error.message }),
        }).catch((error) => {
            this.mediaSession = null;
            throw error;
        });
    }

    setMicrophoneMuted(muted) {
        this.mediaSession?.setMicrophoneMuted(muted);
    }

    setPlaybackMuted(muted) {
        this.mediaSession?.setPlaybackMuted(muted);
    }

    setVolume(volume) {
        this.mediaSession?.setVolume(volume);
    }

    startVideoCapture(options = {}) {
        if (this.videoCapture) return Promise.resolve(this.videoCapture);
        return createVideoCapture({
            deps: this.deps,
            isConfirmed: () => this.state.independent?.confirmed === true,
            sendVideoFrame: (frame, timestamp90k, keyFrame) => this.sendVideoFrame(frame, timestamp90k, keyFrame),
            socketBufferedAmount: () => this.transport.socket?.bufferedAmount || 0,
            emit: (event, data) => this.emit(event, data),
            ...options,
        }).then((capture) => {
            this.videoCapture = capture;
            return capture;
        });
    }

    async stopVideoCapture() {
        const capture = this.videoCapture;
        this.videoCapture = null;
        await stopVideoCapture(capture);
    }

    startVideoDecoder({ codec = "avc1.42E01E", onFrame } = {}) {
        this.videoDecoder?.close();
        this.videoDecoder = createVideoDecoder({
            deps: { VideoDecoder: this.deps.VideoDecoder, EncodedVideoChunk: this.deps.EncodedVideoChunk },
            stats: this.videoStats,
            onFrame,
            emit: (event, data) => this.emit(event, data),
            requestKeyFrame: () => this.requestVideoKeyFrame(),
            codec,
        });
        return this.videoDecoder;
    }

    stopVideoDecoder() {
        this.videoDecoder?.close();
        this.videoDecoder = null;
    }

    reportVideoStatsSoon() {
        if (this.videoStatsTimer) return;
        this.videoStatsTimer = setTimeout(() => {
            this.videoStatsTimer = null;
            if (!this.transport.isOpen || !this.videoStats.received) return;
            this.transport.sendRaw({ event: "video-client-stats", data: { ...this.videoStats } });
        }, 1000);
    }

    sendVideoFrame(frame, timestamp90k, keyFrame = false) {
        if (!this.transport.isOpen) throw new Error("Call gateway is not connected");
        if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 8 * 1024 * 1024)
            throw new RangeError("Encoded video frame must be 1..8388608 bytes");
        if (!Number.isInteger(timestamp90k) || timestamp90k < 0 || timestamp90k > 0xffffffff)
            throw new RangeError("Video RTP timestamp must be a uint32");
        let binary = "";
        const chunk = 0x8000;
        for (let offset = 0; offset < frame.length; offset += chunk)
            binary += String.fromCharCode(...frame.subarray(offset, Math.min(offset + chunk, frame.length)));
        this.transport.sendRaw({ action: "video-frame", data: { timestamp: timestamp90k, keyFrame, frame: btoa(binary) } });
    }

    closeMedia() {
        this.stopVideoCapture().catch(() => {});
        this.videoDecoder?.reset();
        const session = this.mediaSession;
        this.mediaSession = null;
        session?.close();
    }
}
