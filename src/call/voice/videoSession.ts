import { randomInt } from "node:crypto";
import type { ZrtpRelayMedia } from "../relayMediaPacket.js";
import { buildCompoundRtcpPli, buildCompoundRtcpReport, parseCompoundRtcp, type RtcpSenderInfo } from "../rtcp.js";
import { SrtcpContext } from "../srtcp.js";
import { SrtpRtpContext } from "../srtpRtp.js";
import { VideoRtpBridge } from "../videoRtpBridge.js";
import type { MediaSecurity, VideoPlan } from "./negotiate.js";

/** Relay methods the video path needs (ZrtpRelaySession implements all of them). */
export interface VideoRelay {
    sendVideo(rtp: Uint8Array): void;
    sendVideoRtcp(rtcp: Uint8Array): void;
    /** Native RequestForward camera state (0x20/0x07 on, 0x20/0x08 off). Optional. */
    sendLocalCameraState?(on: boolean, reason?: number): void;
    /** Native RequestForward video suspend (0x20/0x11). Optional. */
    sendVideoSuspend?(suspended: boolean, reason?: number): void;
}

/** One encoded H.264 access unit (Annex-B, start codes included). */
export type VideoFrame = {
    data: Uint8Array;
    /** RTP timestamp, 90 kHz clock. */
    timestamp: number;
    keyFrame: boolean;
};

export type VideoSessionCounters = {
    framesSent: number;
    keyFramesSent: number;
    packetsSent: number;
    framesReceived: number;
    keyFramesReceived: number;
    packetsReceived: number;
    packetsRejected: number;
    auxiliaryPackets: number;
    incompleteFrames: number;
    relayVideoIn: number;
    relayVideoRtcpIn: number;
    rtcpSent: number;
    pliSent: number;
    pliReceived: number;
    sendErrors: number;
    droppedBeforeKeyFrame: number;
};

/** Native video RTCPSender runs at ~1 s while sending. */
const RTCP_INTERVAL_MS = 1000;
/** Do not flood the peer with keyframe requests. */
const PLI_MIN_INTERVAL_MS = 500;
/** Keep asking for an IDR until the first decodable keyframe arrives. */
const PLI_UNTIL_KEYFRAME_MS = 1500;

function ntpNow(now: number) {
    return {
        ntpSeconds: (Math.floor(now / 1000) + 2208988800) >>> 0,
        ntpFraction: Math.floor((now % 1000) * 0x100000000 / 1000) >>> 0,
    };
}

/**
 * One call's video leg (H.264 only):
 *   writeVideo(Annex-B AU) → packetizer (nal-annexb for packetMode 2) → SRTP → relay type13
 *   relay type14 → SRTP → AU reassembly (PT locked, aux PT skipped) → onFrame
 * Video SRTP/SRTCP contexts are separate from audio (Peer::getSRTP selects a
 * distinct transport) but keyed from the same master key; SSRC = call user ID.
 */
export class VideoSession {
    readonly counters: VideoSessionCounters = {
        framesSent: 0, keyFramesSent: 0, packetsSent: 0, framesReceived: 0, keyFramesReceived: 0,
        packetsReceived: 0, packetsRejected: 0, auxiliaryPackets: 0, incompleteFrames: 0,
        relayVideoIn: 0, relayVideoRtcpIn: 0, rtcpSent: 0, pliSent: 0, pliReceived: 0,
        sendErrors: 0, droppedBeforeKeyFrame: 0,
    };
    /** False after setCameraEnabled(false): outgoing frames are dropped. */
    cameraEnabled = true;

    private readonly bridge: VideoRtpBridge;
    private periodicTicks = 0;
    private readonly srtcpSend: SrtcpContext | null;
    private readonly srtcpReceive: SrtcpContext | null;
    private readonly localSsrc: number;
    private transmitting = false;
    private closed = false;
    private sentKeyFrame = false;
    private receivedKeyFrame = false;
    private lastPliAt = 0;
    private lastIncomplete = 0;
    private rtcpTimer: ReturnType<typeof setInterval> | null = null;
    private firstFrameAt = 0;

    constructor(
        private readonly relay: VideoRelay,
        security: MediaSecurity,
        readonly plan: VideoPlan,
        private readonly onFrame: (frame: VideoFrame) => void,
        private readonly onKeyFrameRequest: () => void,
        private readonly onError: (error: Error) => void,
        options: { pacing?: boolean } = {},
    ) {
        const { masterKeySalt, profile, localSsrc, remoteSsrc } = security;
        this.localSsrc = localSsrc;
        const initialSequenceNumber = randomInt(1, 0x8000);
        // Copy the key: audio zeroes its own copy on close.
        const key = Uint8Array.from(masterKeySalt);
        const receiveContext = (ssrc: number, sequenceNumber: number) =>
            new SrtpRtpContext({ masterKeySalt: key, profile, direction: "receive", ssrc, initialRoc: 0, initialSequenceNumber: sequenceNumber });
        this.bridge = new VideoRtpBridge({
            relay: { sendVideo: rtp => relay.sendVideo(rtp) },
            codec: "h264",
            payloadType: plan.payloadType,
            packetMode: plan.packetMode,
            packetFormat: plan.packetFormat,
            pacing: options.pacing ?? true,
            // Live Zalo peers put PT97 media and PT98 auxiliary packets in one
            // SSRC/sequence space; native registers every candidate receive codec.
            receivePayloadTypes: [...new Set([plan.payloadType, 97, 98, 100])],
            localSsrc, remoteSsrc, initialSequenceNumber,
            protect: new SrtpRtpContext({ masterKeySalt: key, profile, direction: "send", ssrc: localSsrc, initialRoc: 0, initialSequenceNumber }),
            unprotect: receiveContext(remoteSsrc, 0),
            unprotectFactory: receiveContext,
            onFrame: frame => this.deliver(frame),
        });
        this.srtcpSend = security.srtcp ? new SrtcpContext({ masterKeySalt: key, profile, direction: "send" }) : null;
        this.srtcpReceive = security.srtcp ? new SrtcpContext({ masterKeySalt: key, profile, direction: "receive" }) : null;
        key.fill(0);
    }

    /** Begin sending/accepting video RTP (call confirmed). Idempotent. */
    startTransmitting(): void {
        if (this.closed || this.transmitting) return;
        this.transmitting = true;
        this.bridge.setConfirmed(true);
        this.signalCamera(this.cameraEnabled);
        this.rtcpTimer = setInterval(() => this.periodic(), RTCP_INTERVAL_MS);
        this.requestKeyFrame(true);
    }

    /**
     * Send one encoded H.264 access unit. Frames before the first keyframe are
     * dropped (the peer cannot decode them). Returns RTP packets sent.
     */
    write(data: Uint8Array, timestamp90k: number, keyFrame: boolean): number {
        if (this.closed || !this.transmitting || !this.cameraEnabled) return 0;
        if (!this.sentKeyFrame && !keyFrame) { this.counters.droppedBeforeKeyFrame++; return 0; }
        try {
            const packets = this.bridge.sendFrame(data, timestamp90k >>> 0, keyFrame);
            if (keyFrame) { this.sentKeyFrame = true; this.counters.keyFramesSent++; }
            this.counters.framesSent++;
            this.counters.packetsSent += packets;
            return packets;
        } catch (error) {
            this.counters.sendErrors++;
            if (this.counters.sendErrors === 1 || this.counters.sendErrors % 100 === 0)
                this.onError(error instanceof Error ? error : new Error(String(error)));
            return 0;
        }
    }

    setCameraEnabled(enabled: boolean): void {
        enabled = Boolean(enabled);
        if (enabled === this.cameraEnabled) return;
        this.cameraEnabled = enabled;
        // After re-enabling, wait for a fresh keyframe from the encoder.
        if (enabled) this.sentKeyFrame = false;
        if (this.transmitting) this.signalCamera(enabled);
    }

    /** Ask the peer for an IDR (compound RTCP SR/RR + SDES + PLI). */
    requestKeyFrame(force = false): void {
        if (this.closed || !this.transmitting) return;
        const now = Date.now();
        if (!force && now - this.lastPliAt < PLI_MIN_INTERVAL_MS) return;
        this.lastPliAt = now;
        try {
            const pli = buildCompoundRtcpPli(this.localSsrc, this.bridge.remoteVideoSsrc, `zrtc-${this.localSsrc}`, this.senderInfo(now));
            this.relay.sendVideoRtcp(this.srtcpSend ? this.srtcpSend.protect(pli) : pli);
            this.counters.pliSent++;
        } catch { /* RTCP is best effort */ }
    }

    receive(packet: ZrtpRelayMedia): void {
        if (this.closed) return;
        if (packet.kind === "video") {
            this.counters.relayVideoIn++;
            this.bridge.receiveRtp(packet.payload);
            this.counters.packetsReceived = this.bridge.receivedPackets;
            this.counters.packetsRejected = this.bridge.rejectedPackets;
            this.counters.auxiliaryPackets = this.bridge.auxiliaryPackets;
            const incomplete = this.bridge.incompleteAccessUnits;
            this.counters.incompleteFrames = incomplete;
            if (incomplete > this.lastIncomplete) { this.lastIncomplete = incomplete; this.requestKeyFrame(); }
            return;
        }
        if (packet.kind !== "videoRtcp") return;
        this.counters.relayVideoRtcpIn++;
        try {
            const clear = this.srtcpReceive ? this.srtcpReceive.unprotect(packet.payload) : packet.payload;
            for (const summary of parseCompoundRtcp(clear)) {
                // PSFB (206) FMT 1 = PLI; FMT 4 = FIR. Either asks us for a keyframe.
                if (summary.packetType === 206 && (summary.count === 1 || summary.count === 4)) {
                    this.counters.pliReceived++;
                    // Notify only: dropping delta frames here would freeze our
                    // video for a whole GOP when the app cannot force an IDR.
                    try { this.onKeyFrameRequest(); } catch { /* listener */ }
                }
                if (summary.packetType === 200 && summary.senderInfo)
                    this.bridge.noteSenderReport(summary.senderInfo.ntpSeconds, summary.senderInfo.ntpFraction, Date.now());
            }
        } catch { /* ignore unauthenticated / malformed RTCP */ }
    }

    diagnostics(): Record<string, number | string | boolean | null> {
        return {
            videoPayloadType: this.plan.payloadType, videoPacketMode: this.plan.packetMode,
            videoPacketFormat: this.bridge.packetFormatName, videoCameraEnabled: this.cameraEnabled,
            videoReceivePayloadType: this.bridge.receivePayloadType ?? null,
            videoPacingDropped: this.bridge.pacingDropped,
            // Bounded format-RE trace (clear payload heads only; no keys, no addresses).
            videoObservedFirstBytes: JSON.stringify(this.bridge.observedPayloadFirstBytes),
            videoReceivedNalTypes: JSON.stringify(this.bridge.receivedH264NalTypes),
            videoSentNalTypes: JSON.stringify(this.bridge.sentH264NalTypes),
            videoReceivedSamples: this.bridge.receivedSamples.join(" "),
            videoSentSamples: this.bridge.sentSamples.join(" "),
            ...Object.fromEntries(Object.entries(this.counters).map(([k, v]) => [`video${k[0].toUpperCase()}${k.slice(1)}`, v])),
        };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.transmitting = false;
        if (this.rtcpTimer) clearInterval(this.rtcpTimer);
        this.rtcpTimer = null;
        this.bridge.close();
        this.srtcpSend?.destroy();
        this.srtcpReceive?.destroy();
    }

    private deliver(frame: { data: Uint8Array; timestamp: number; keyFrame: boolean }) {
        if (!this.receivedKeyFrame && !frame.keyFrame) return;
        if (frame.keyFrame) { this.receivedKeyFrame = true; this.counters.keyFramesReceived++; }
        if (!this.firstFrameAt) this.firstFrameAt = Date.now();
        this.counters.framesReceived++;
        try { this.onFrame({ data: frame.data, timestamp: frame.timestamp, keyFrame: frame.keyFrame }); }
        catch (error) { this.onError(error instanceof Error ? error : new Error(String(error))); }
    }

    private periodic() {
        if (this.closed) return;
        // Native _handleZRTPReqForward ignores camera forwards (0x20/0x07..0x09)
        // until the peer's call is active, and the relay is plain UDP. One
        // forward sent at our confirm can therefore be lost (live 2026-11-28:
        // Zalo Desktop never left "partner camera off"). Repeat it; the peer
        // only acts on a state change.
        this.periodicTicks++;
        if (this.periodicTicks <= 2 || this.periodicTicks === 4 || this.periodicTicks % 5 === 0) this.signalCamera(this.cameraEnabled);
        if (!this.receivedKeyFrame && Date.now() - this.lastPliAt >= PLI_UNTIL_KEYFRAME_MS) this.requestKeyFrame(true);
        try {
            const now = Date.now();
            const block = this.bridge.buildReceptionReportBlock(now);
            // Native RTCPSender emits SR (not RR) while the video sender is active.
            const report = buildCompoundRtcpReport({ ssrc: this.localSsrc, cname: `zrtc-${this.localSsrc}`,
                reportBlocks: block ? [block] : [], senderInfo: this.senderInfo(now) });
            this.relay.sendVideoRtcp(this.srtcpSend ? this.srtcpSend.protect(report) : report);
            this.counters.rtcpSent++;
        } catch { /* best effort */ }
    }

    private senderInfo(now: number): RtcpSenderInfo | undefined {
        if (!this.bridge.sentPackets) return undefined;
        return { ...ntpNow(now), rtpTimestamp: this.bridge.lastSentTimestamp >>> 0,
            packetCount: this.bridge.sentPackets >>> 0, octetCount: this.bridge.sentOctets >>> 0 };
    }

    private signalCamera(on: boolean) {
        // Relay-level camera state, as the legacy engine sent on confirmation.
        // The authoritative signal for the Zalo UI is /conf (sent by VoiceCall).
        try { this.relay.sendLocalCameraState?.(on, 0); } catch { /* optional */ }
        try { this.relay.sendVideoSuspend?.(!on, 0); } catch { /* optional */ }
    }
}
