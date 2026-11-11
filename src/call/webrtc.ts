/**
 * Optional WebRTC helper (`zca-js/call-webrtc`): connects a browser (mic +
 * speaker) to a VoiceCall through a server-side RTCPeerConnection. Requires the
 * optional peer dependency `@roamhq/wrtc`. Audio only.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type * as WrtcModule from "@roamhq/wrtc";
import type { VoiceCall } from "./voice/voiceCall.js";
import { PCM_RATE, PcmRing, toMono48k } from "./voice/pcm.js";

export type BridgeIceServer = { urls: string | string[]; username?: string; credential?: string };
export type BridgeSessionDescription = { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string };
export type BridgePeerConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type WebRtcBridgeOptions = {
    iceServers?: BridgeIceServer[];
    /** ICE gathering timeout for accept(). Default 8000 ms. */
    iceTimeoutMs?: number;
};

type Wrtc = typeof WrtcModule;
let cached: Wrtc | null = null;
function loadWrtc(): Wrtc {
    if (cached) return cached;
    try {
        cached = createRequire(import.meta.url)("@roamhq/wrtc") as Wrtc;
        return cached;
    } catch {
        throw new Error("zca-js/call-webrtc requires the optional peer dependency @roamhq/wrtc (npm i @roamhq/wrtc)");
    }
}

/** 10 ms playout frames towards the browser. */
const FRAME = PCM_RATE / 100;
/** Peer → browser jitter buffer bound (200 ms). */
const MAX_PLAYOUT = PCM_RATE / 5;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export interface WebRtcBridge {
    on(event: "state", listener: (state: BridgePeerConnectionState) => void): this;
    off(event: "state", listener: (state: BridgePeerConnectionState) => void): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export class WebRtcBridge extends EventEmitter {
    private readonly pc: InstanceType<Wrtc["RTCPeerConnection"]>;
    private readonly source: InstanceType<Wrtc["nonstandard"]["RTCAudioSource"]>;
    private readonly track: ReturnType<InstanceType<Wrtc["nonstandard"]["RTCAudioSource"]>["createTrack"]>;
    private sink: InstanceType<Wrtc["nonstandard"]["RTCAudioSink"]> | null = null;
    private readonly playout = new PcmRing(MAX_PLAYOUT);
    private call: VoiceCall | null = null;
    private detachCall: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private nextTick = 0;
    private closed = false;
    private readonly iceTimeoutMs: number;

    constructor(options: WebRtcBridgeOptions = {}) {
        super();
        const wrtc = loadWrtc();
        this.iceTimeoutMs = options.iceTimeoutMs ?? 8000;
        this.pc = new wrtc.RTCPeerConnection({ iceServers: options.iceServers ?? [] } as never);
        this.source = new wrtc.nonstandard.RTCAudioSource();
        this.track = this.source.createTrack();
        this.pc.addTrack(this.track, new wrtc.MediaStream([this.track]));
        this.pc.onconnectionstatechange = () => {
            const state = this.pc.connectionState as BridgePeerConnectionState;
            try { this.emit("state", state); } catch { /* listener errors must not break media */ }
        };
        this.pc.ontrack = (event: { track: { kind: string } }) => {
            if (event.track.kind !== "audio") return;
            this.sink?.stop();
            this.sink = new wrtc.nonstandard.RTCAudioSink(event.track as never);
            (this.sink as unknown as { ondata: ((data: { samples: Int16Array; sampleRate: number; channelCount?: number }) => void) | null }).ondata = data => {
                if (this.closed || !this.call) return;
                try { this.call.writeAudio(toMono48k(data.samples, data.sampleRate, data.channelCount || 1)); } catch { /* ignore */ }
            };
        };
        this.nextTick = performance.now();
        this.pump();
    }

    /** Apply the browser's offer and return the complete answer (ICE gathered). */
    async accept(offer: BridgeSessionDescription): Promise<BridgeSessionDescription> {
        if (this.closed) throw new Error("WebRTC bridge is closed");
        await this.pc.setRemoteDescription(offer as never);
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.waitIce();
        const local = this.pc.localDescription!;
        return { type: local.type as BridgeSessionDescription["type"], sdp: local.sdp };
    }

    /** Route audio both ways between the browser and `call`. Replaces any previous call. */
    attach(call: VoiceCall): void {
        if (this.closed) return;
        this.detach();
        if (call.state === "ended") return;
        const onAudio = (pcm: Int16Array) => this.playout.push(pcm);
        const onEnded = () => this.detach();
        call.on("audio", onAudio);
        call.once("ended", onEnded);
        this.call = call;
        this.detachCall = () => { call.off("audio", onAudio); call.off("ended", onEnded); };
    }

    /** Stop routing audio; the browser keeps receiving silence. */
    detach(): void {
        this.detachCall?.();
        this.detachCall = null;
        this.call = null;
        this.playout.clear();
    }

    get connectionState(): BridgePeerConnectionState { return this.pc.connectionState as BridgePeerConnectionState; }

    /** Idempotent. Does not hang up the call. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.detach();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.sink) { (this.sink as unknown as { ondata: null }).ondata = null; this.sink.stop(); this.sink = null; }
        this.pc.ontrack = null;
        try { this.track.stop(); } catch { /* ignore */ }
        try { this.pc.close(); } catch { /* ignore */ }
        this.pc.onconnectionstatechange = null;
        this.removeAllListeners();
    }

    private pump() {
        if (this.closed) return;
        const now = performance.now();
        let frames = 0;
        while (now >= this.nextTick && frames++ < 3) {
            this.source.onData({ samples: this.playout.read(FRAME), sampleRate: PCM_RATE, bitsPerSample: 16, channelCount: 1, numberOfFrames: FRAME });
            this.nextTick += 10;
        }
        if (now - this.nextTick > 100) this.nextTick = now + 10;
        this.timer = setTimeout(() => this.pump(), Math.max(1, this.nextTick - performance.now()));
    }

    private waitIce(): Promise<void> {
        if (this.pc.iceGatheringState === "complete") return Promise.resolve();
        return new Promise((resolve, reject) => {
            const done = (error?: Error) => {
                clearTimeout(timeout);
                this.pc.removeEventListener("icegatheringstatechange", check);
                if (error) reject(error); else resolve();
            };
            const check = () => { if (this.pc.iceGatheringState === "complete") done(); };
            const timeout = setTimeout(() => done(new Error("ICE gathering timed out")), this.iceTimeoutMs);
            this.pc.addEventListener("icegatheringstatechange", check);
            check();
        });
    }
}

export function createWebRtcBridge(options: WebRtcBridgeOptions = {}): WebRtcBridge {
    return new WebRtcBridge(options);
}
