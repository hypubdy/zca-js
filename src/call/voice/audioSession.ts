import { randomInt } from "node:crypto";
import type { ZrtpRelayMedia } from "../relayMediaPacket.js";
import { parseRtpPacket, RtpAudioSender } from "../rtpAudio.js";
import { buildCompoundRtcpReport, parseCompoundRtcp, RtpReceptionStats } from "../rtcp.js";
import { SrtcpContext } from "../srtcp.js";
import { SrtpRtpContext } from "../srtpRtp.js";
import type { MediaSecurity } from "./negotiate.js";
import { OpusCodec } from "./opus.js";
import { PCM_RATE, PcmRing, RmsMeter } from "./pcm.js";

/** Subset of ZrtpRelaySession used by the audio path (injectable for tests). */
export interface AudioRelay {
    readonly relay: { address: string; port: number };
    sendAudio(rtp: Uint8Array): void;
    sendAudioRtcp(rtcp: Uint8Array): void;
    close(sendEnd?: boolean): void;
}

export type AudioSessionCounters = {
    packetsSent: number;
    packetsReceived: number;
    packetsLost: number;
    relayAudioIn: number;
    relayFecIn: number;
    relayRtcpIn: number;
    wrongPayloadType: number;
    wrongSsrc: number;
    srtpRejected: number;
    decodeFailed: number;
    sendErrors: number;
    rtcpSent: number;
    rtcpReceived: number;
    droppedInputSamples: number;
};

/** Max buffered outbound audio: 200 ms at 48 kHz. Older audio is dropped. */
const MAX_INPUT_SAMPLES = PCM_RATE / 5;
/** Native AudioRtpRtcp sets RtcpReportInterval() to 2500 ms. */
const RTCP_INTERVAL_MS = 2500;

/**
 * One call's audio pipeline:
 *   writeAudio → ring (≤200 ms) → paced Opus frames → RTP → SRTP → relay type3
 *   relay type4 → SRTP auth/decrypt → RTP → Opus decode → onAudio(48 kHz mono)
 *
 * Native disables DTX/VAD, so a frame is sent every frame interval while
 * transmitting; silence (zeros) is encoded when muted or when the ring is empty.
 */
export class AudioSession {
    readonly counters: AudioSessionCounters = {
        packetsSent: 0, packetsReceived: 0, packetsLost: 0, relayAudioIn: 0, relayFecIn: 0, relayRtcpIn: 0,
        wrongPayloadType: 0, wrongSsrc: 0, srtpRejected: 0, decodeFailed: 0, sendErrors: 0,
        rtcpSent: 0, rtcpReceived: 0, droppedInputSamples: 0,
    };
    readonly inputMeter = new RmsMeter();
    readonly outputMeter = new RmsMeter();
    muted = false;

    private readonly opus: OpusCodec;
    private readonly ring = new PcmRing(MAX_INPUT_SAMPLES);
    private readonly sender: RtpAudioSender;
    private readonly protect: SrtpRtpContext;
    private unprotect: SrtpRtpContext | null = null;
    private readonly srtcpSend: SrtcpContext | null;
    private readonly srtcpReceive: SrtcpContext | null;
    private readonly reception: RtpReceptionStats;
    private sentOctets = 0;
    private transmitting = false;
    private closed = false;
    private pacer: ReturnType<typeof setTimeout> | null = null;
    private rtcpTimer: ReturnType<typeof setInterval> | null = null;
    private nextTick = 0;

    constructor(
        private readonly relay: AudioRelay,
        private readonly security: MediaSecurity,
        private readonly onAudio: (pcm: Int16Array) => void,
        private readonly onError: (error: Error) => void,
    ) {
        const { codec, localSsrc, masterKeySalt, profile } = security;
        this.opus = new OpusCodec(codec);
        // Native RTPSender::SetSSRC picks Random::Rand(1, 0x7fff).
        const initialSequenceNumber = randomInt(1, 0x8000);
        this.sender = new RtpAudioSender({
            ssrc: localSsrc, payloadType: codec.payloadType,
            // Native AudioEncoderOpusImpl::RtpTimestampRateHz == SampleRateHz (16k variant uses a 16k clock).
            clockRate: codec.sampleRate, timestampStep: codec.sampleRate * codec.frameMs / 1000, initialSequenceNumber,
        });
        this.protect = new SrtpRtpContext({ masterKeySalt, profile, direction: "send", ssrc: localSsrc, initialRoc: 0, initialSequenceNumber });
        this.srtcpSend = security.srtcp ? new SrtcpContext({ masterKeySalt, profile, direction: "send" }) : null;
        this.srtcpReceive = security.srtcp ? new SrtcpContext({ masterKeySalt, profile, direction: "receive" }) : null;
        this.reception = new RtpReceptionStats(codec.sampleRate);
    }

    get frameMs(): number { return this.security.codec.frameMs; }

    /** Queue 48 kHz mono PCM for sending. Never blocks; bounded to 200 ms. */
    write(pcm: Int16Array): void {
        if (this.closed || !this.transmitting || !pcm.length) return;
        const before = this.ring.dropped;
        this.ring.push(pcm);
        this.counters.droppedInputSamples += this.ring.dropped - before;
    }

    /** Begin sending RTP (call confirmed). Idempotent. */
    startTransmitting(): void {
        if (this.closed || this.transmitting) return;
        this.transmitting = true;
        this.nextTick = performance.now();
        this.schedulePacer(0);
        this.rtcpTimer = setInterval(() => this.sendRtcp(), RTCP_INTERVAL_MS);
    }

    private schedulePacer(delay: number) {
        this.pacer = setTimeout(() => this.pump(), Math.max(0, delay));
    }

    private pump() {
        if (this.closed) return;
        const frameMs = this.frameMs;
        const now = performance.now();
        // Catch up at most 3 frames after a stall, then resynchronise.
        let sent = 0;
        while (now >= this.nextTick && sent < 3) {
            this.sendFrame();
            this.nextTick += frameMs;
            sent++;
        }
        if (now - this.nextTick > 5 * frameMs) this.nextTick = now + frameMs;
        this.schedulePacer(this.nextTick - performance.now());
    }

    private sendFrame() {
        const samples = this.opus.frameSamples48k;
        let frame = this.ring.read(samples);
        if (this.muted) frame = new Int16Array(samples);
        this.inputMeter.update(frame);
        try {
            const payload = this.opus.encode48k(frame);
            const rtp = this.sender.packet(payload);
            this.relay.sendAudio(this.protect.protect(rtp));
            this.counters.packetsSent++;
            this.sentOctets += payload.length;
        } catch (error) {
            this.counters.sendErrors++;
            if (this.counters.sendErrors === 1 || this.counters.sendErrors % 100 === 0)
                this.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private sendRtcp() {
        if (this.closed) return;
        try {
            const now = Date.now();
            const counters = this.sender.counters();
            const senderInfo = this.counters.packetsSent ? {
                ntpSeconds: (Math.floor(now / 1000) + 2208988800) >>> 0,
                ntpFraction: Math.floor((now % 1000) * 0x100000000 / 1000) >>> 0,
                rtpTimestamp: counters.timestamp >>> 0,
                packetCount: this.counters.packetsSent >>> 0,
                octetCount: this.sentOctets >>> 0,
            } : undefined;
            const block = this.reception.reportBlock(this.security.remoteSsrc, now);
            if (block) this.counters.packetsLost = Math.max(0, block.cumulativeLost);
            const report = buildCompoundRtcpReport({ ssrc: counters.ssrc, cname: `zrtc-${counters.ssrc}`, senderInfo,
                reportBlocks: block ? [block] : [] });
            this.relay.sendAudioRtcp(this.srtcpSend ? this.srtcpSend.protect(report) : report);
            this.counters.rtcpSent++;
        } catch {
            /* RTCP is best effort; never surface packet contents. */
        }
    }

    /** Feed a packet received from the relay. */
    receive(packet: ZrtpRelayMedia): void {
        if (this.closed) return;
        if (packet.kind === "audioFec") { this.counters.relayFecIn++; return; }
        if (packet.kind === "audioRtcp") {
            this.counters.relayRtcpIn++;
            try {
                const clear = this.srtcpReceive ? this.srtcpReceive.unprotect(packet.payload) : packet.payload;
                for (const summary of parseCompoundRtcp(clear))
                    if (summary.packetType === 200 && summary.senderInfo)
                        this.reception.setLastSenderReport(summary.senderInfo.ntpSeconds, summary.senderInfo.ntpFraction, Date.now());
                this.counters.rtcpReceived++;
            } catch { /* ignore unauthenticated / malformed RTCP */ }
            return;
        }
        if (packet.kind !== "audio") return;
        this.counters.relayAudioIn++;
        const bytes = packet.payload;
        if (bytes.length < 12 || bytes[0] >>> 6 !== 2) { this.counters.srtpRejected++; return; }
        const { codec, remoteSsrc, masterKeySalt, profile } = this.security;
        if ((bytes[1] & 0x7f) !== codec.payloadType) { this.counters.wrongPayloadType++; return; }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sequenceNumber = view.getUint16(2);
        const ssrc = view.getUint32(8);
        if (ssrc !== remoteSsrc) { this.counters.wrongSsrc++; return; }
        let clear: Uint8Array;
        try {
            if (!this.unprotect) this.unprotect = new SrtpRtpContext({ masterKeySalt, profile, direction: "receive", ssrc, initialRoc: 0, initialSequenceNumber: sequenceNumber });
            clear = this.unprotect.unprotect(bytes);
        } catch { this.counters.srtpRejected++; return; }
        let rtp;
        try { rtp = parseRtpPacket(clear); } catch { this.counters.srtpRejected++; return; }
        try { this.reception.update(rtp.sequenceNumber, rtp.timestamp, Date.now()); } catch { /* stats only */ }
        let pcm: Int16Array;
        try { pcm = this.opus.decodeTo48k(rtp.payload); } catch { this.counters.decodeFailed++; return; }
        this.counters.packetsReceived++;
        this.outputMeter.update(pcm);
        try { this.onAudio(pcm); } catch (error) { this.onError(error instanceof Error ? error : new Error(String(error))); }
    }

    close(sendEnd = true): void {
        if (this.closed) return;
        this.closed = true;
        this.transmitting = false;
        if (this.pacer) clearTimeout(this.pacer);
        if (this.rtcpTimer) clearInterval(this.rtcpTimer);
        this.pacer = null; this.rtcpTimer = null;
        this.ring.clear();
        try { this.relay.close(sendEnd); } catch { /* local cleanup must continue */ }
        this.opus.close();
        this.protect.destroy();
        this.unprotect?.destroy();
        this.srtcpSend?.destroy();
        this.srtcpReceive?.destroy();
        this.security.masterKeySalt.fill(0);
    }
}
