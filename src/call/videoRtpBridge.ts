import { parseRtpPacket } from "./rtpAudio.js";
import { randomBytes } from "node:crypto";
import { RtpReceptionStats } from "./rtcp.js";
import { Vp8RtpDepacketizer, Vp8RtpPacketizer } from "./rtpVp8.js";
import { H264RtpDepacketizer, H264RtpPacketizer, splitH264Nals } from "./rtpH264.js";
import type { SrtpRtpContext } from "./srtpRtp.js";

function hasH264KeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && [5, 19, 20].includes(data[i + 3] & 0x1f)) return true;
        if (i + 4 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1 && [5, 19, 20].includes(data[i + 4] & 0x1f)) return true;
    }
    return false;
}

export type VideoRelaySender = { sendVideo(packet: Uint8Array): void };
export type VideoRtpBridgeOptions = {
    relay: VideoRelaySender;
    payloadType: number;
    localSsrc: number;
    remoteSsrc: number;
    initialSequenceNumber: number;
    protect: SrtpRtpContext;
    unprotect: SrtpRtpContext;
    /** Optional first-packet factory when native video SSRC is not the user ID. */
    unprotectFactory?: (ssrc: number, sequenceNumber: number) => SrtpRtpContext;
    onFrame: (frame: { data: Uint8Array; timestamp: number; keyFrame: boolean; codec?: "vp8" | "h264" }) => void;
    maxPacketSize?: number;
    /** Codec packetization mode. Defaults to VP8 for backward compatibility. */
    codec?: "vp8" | "h264";
    /** Native Zalo video modes observed live carry raw Annex-B RTP chunks. */
    packetMode?: number;
    /**
     * "nal" keeps each Annex-B NAL in one packet (FU-A only for oversized NALs),
     * matching a live packetMode-2 Zalo sender. "balanced" is the native
     * packetMode-1 raw splitter. "rfc6184" strips start codes.
     */
    packetFormat?: "nal" | "balanced" | "rfc6184";
    /**
     * Emit the native RapidSync/SVC RTP header extension. Off by default: the
     * live Zalo peer sent no extensions, and a receiver that does not honour
     * the X bit would misplace the payload. Enable to compare against Zalo PC.
     */
    extensions?: boolean;
    /** Bounded receive payload aliases for native signaling/RTP payload differences. */
    receivePayloadTypes?: readonly number[];
};

/**
 * VP8/H264 RTP relay leg. Every negotiated media value and crypto context is injected;
 * this class does not guess the Zalo video payload type, SSRCs, or answer shape.
 */
export class VideoRtpBridge {
    packetizer: Vp8RtpPacketizer | H264RtpPacketizer;
    readonly depacketizer: Vp8RtpDepacketizer | H264RtpDepacketizer;
    private confirmed = false;
    private closed = false;
    private payloadType: number;
    private readonly receivePayloadTypes: ReadonlySet<number>;
    private remoteSsrc: number;
    private readonly unprotectFactory?: VideoRtpBridgeOptions["unprotectFactory"];
    /** Some native peers advertise H264 but send VP8 payloads on the same PT. */
    private readonly vp8Fallback?: Vp8RtpDepacketizer;
    private vp8Timestamp?: number;
    private rawH264Timestamp?: number;
    private rawH264PayloadType?: number;
    /** Out-of-order tolerant access-unit chunks keyed by RTP sequence number. */
    private rawH264Packets = new Map<number, Uint8Array>();
    private rawH264FirstSequence = 0;
    private rawH264LastSequence = 0;
    /** Sequence numbers of auxiliary (FEC/RTX) packets that belong to this SSRC. */
    private rawH264AuxSequences = new Set<number>();
    private rawH264Total = 0;
    private readonly rawH264PacketMode: boolean;
    private packetFormat: "nal" | "balanced" | "rfc6184";
    private emitExtensions: boolean;
    private readonly configuredMaxPacketSize?: number;
    /** Next RTP sequence number; kept monotonic across live format switches. */
    private nextSequence: number;
    /** Random 32-bit RTP timestamp base, mirroring native WebRTC's random offset. */
    private timestampOffset?: number;
    private readonly relay: VideoRelaySender;
    private readonly localSsrc: number;
    private readonly receptionStats = new RtpReceptionStats(90000);
    private readonly protect: SrtpRtpContext;
    private unprotect: SrtpRtpContext;
    private readonly onFrame: VideoRtpBridgeOptions["onFrame"];
    sentPackets = 0;
    sentFrames = 0;
    sentKeyFrames = 0;
    /** Payload octets and last RTP timestamp for the sender report (native RTCPSender). */
    sentOctets = 0;
    lastSentTimestamp = 0;
    /** Packets that belong to the same SSRC but not to the media payload (FEC/RTX/aux codec). */
    auxiliaryPackets = 0;
    /** Payload byte statistics used to spot black/static placeholder frames. */
    sentFrameBytes = 0;
    receivedFrameBytes = 0;
    receivedFrameMinBytes = 0;
    receivedFrameMaxBytes = 0;
    /** Access units dropped because RTP packets were missing or out of range. */
    incompleteAccessUnits = 0;
    receivedPackets = 0;
    receivedFrames = 0;
    receivedKeyFrames = 0;
    receiveCodec: "vp8" | "h264";
    /** Payload type currently locked for raw H.264 media, when known. */
    receivePayloadType?: number;
    rejectedPackets = 0;
    readonly rejectionReasons: Record<string, number> = {};
    readonly observedSsrcs: Record<string, number> = {};
    readonly observedPayloadTypes: Record<string, number> = {};
    readonly observedPayloadFirstBytes: Record<string, number> = {};
    readonly observedExtensionProfiles: Record<string, number> = {};
    readonly observedExtensionElements: Record<string, number> = {};
    readonly observedExtensionSamples: Record<string, string[]> = {};
    readonly sentH264NalTypes: Record<string, number> = {};
    readonly sentH264NalSamples: Record<string, string> = {};
    readonly receivedH264NalTypes: Record<string, number> = {};
    readonly receivedH264NalSamples: Record<string, string> = {};
    lastRejection?: { message: string; payloadType?: number; nalType?: number };

    constructor(options: VideoRtpBridgeOptions) {
        if (!Number.isInteger(options.remoteSsrc) || options.remoteSsrc < 0 || options.remoteSsrc > 0xffffffff)
            throw new RangeError("Invalid remote video SSRC");
        if (!options.relay || typeof options.relay.sendVideo !== "function" || typeof options.onFrame !== "function")
            throw new TypeError("Video relay and decoded-frame callback are required");
        this.relay = options.relay;
        this.localSsrc = options.localSsrc;
        this.payloadType = options.payloadType;
        const receiveTypes = options.receivePayloadTypes ?? [options.payloadType];
        if (!receiveTypes.length || receiveTypes.length > 8 || receiveTypes.some(value => !Number.isInteger(value) || value < 0 || value > 127))
            throw new RangeError("Invalid receive video payload aliases");
        this.receivePayloadTypes = new Set(receiveTypes);
        this.remoteSsrc = options.remoteSsrc;
        this.unprotectFactory = options.unprotectFactory;
        this.protect = options.protect;
        this.unprotect = options.unprotect;
        this.onFrame = options.onFrame;
        // ZaloCall explicitly maps mode 1 to internal packetizer mode 7. A live
        // mode-2 call also emitted Annex-B (00 00 01) in PT97 payloads. Mirror
        // the shipped peer for both negotiated native modes.
        this.rawH264PacketMode = options.packetMode === 1 || options.packetMode === 2;
        this.nextSequence = options.initialSequenceNumber;
        this.configuredMaxPacketSize = options.maxPacketSize;
        this.emitExtensions = options.extensions === true && this.rawH264PacketMode;
        if ((options.codec ?? "vp8") === "h264") {
            this.packetFormat = options.packetFormat ?? (options.packetMode === 1 ? "balanced" : "nal");
            this.packetizer = this.createH264Packetizer(this.packetFormat, options.initialSequenceNumber);
            this.depacketizer = new H264RtpDepacketizer();
            this.vp8Fallback = new Vp8RtpDepacketizer();
            this.receiveCodec = "h264";
        } else {
            this.packetFormat = "nal";
            this.packetizer = new Vp8RtpPacketizer({ payloadType: options.payloadType, ssrc: options.localSsrc,
                initialSequenceNumber: options.initialSequenceNumber, maxPacketSize: options.maxPacketSize });
            this.depacketizer = new Vp8RtpDepacketizer();
            this.receiveCodec = "vp8";
        }
    }

    /**
     * ZaloCall registers RapidSync as extension ID 13 and VideoSvcLayerIdx as
     * ID 14 for one-to-one video. Its native serializer emits two 7-byte
     * RFC5285 elements in this order on every video RTP packet.
     */
    private buildNativeVideoExtensions(timestamp: number) {
        const data = new Uint8Array(16);
        const view = new DataView(data.buffer);
        data[0] = 0xd6; // ID 13, seven-byte RapidSyncData.
        data[1] = timestamp >>> 16;
        data[2] = timestamp >>> 8;
        data[3] = timestamp;
        // Native RapidSync stores a 24-bit RTP-side clock followed by a
        // 32-bit wall-clock value. NTP fractional seconds preserve that shape.
        const now = Date.now();
        const ntpFraction = Math.floor(((now % 1000) / 1000) * 0x100000000) >>> 0;
        view.setUint32(4, ntpFraction, false);
        data[8] = 0xe6; // ID 14, seven-byte SFUExtensionData.
        // The native BuildVideoGroupCallExtension serializer emits seven zero
        // bytes when its SFUExtensionData pointer is null. This browser sender
        // does not produce native SVC metadata, so don't fabricate layer/frame
        // indices which could make a peer classify the stream as another layer.
        return { profile: 0xbede, data };
    }

    private createH264Packetizer(format: "nal" | "balanced" | "rfc6184", sequence: number) {
        const packetization = format === "rfc6184" ? "rfc6184" : format === "balanced" ? "zrtp" : "nal-annexb";
        return new H264RtpPacketizer({ payloadType: this.payloadType, ssrc: this.localSsrc,
            initialSequenceNumber: sequence, maxPacketSize: this.configuredMaxPacketSize,
            packetization,
            headerExtension: this.emitExtensions ? (timestamp => this.buildNativeVideoExtensions(timestamp)) : undefined });
    }

    /**
     * Swap the outgoing packetization without touching SRTP state or the RTP
     * sequence space, so a live A/B comparison does not desynchronise the peer.
     */
    setPacketFormat(format: "nal" | "balanced" | "rfc6184", extensions?: boolean, payloadType?: number) {
        if (!["nal", "balanced", "rfc6184"].includes(format)) throw new RangeError("Invalid video packet format");
        if (!(this.packetizer instanceof H264RtpPacketizer)) throw new Error("Only H264 packetization can be switched");
        if (typeof extensions === "boolean") this.emitExtensions = extensions && this.rawH264PacketMode;
        if (payloadType !== undefined) {
            if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127)
                throw new RangeError("Invalid RTP payload type");
            this.payloadType = payloadType;
        }
        this.packetFormat = format;
        this.packetizer = this.createH264Packetizer(format, this.nextSequence);
        return format;
    }

    get sentPayloadType() { return this.payloadType; }

    get extensionsEnabled() { return this.emitExtensions; }

    get packetFormatName() { return this.packetFormat; }
    get nextSequenceNumber() { return this.nextSequence; }

    setConfirmed(confirmed: boolean) { this.confirmed = confirmed; }
    get remoteVideoSsrc() { return this.remoteSsrc; }
    get localVideoSsrc() { return this.localSsrc; }
    buildReceptionReportBlock(nowMs = Date.now()) {
        return this.receptionStats.reportBlock(this.remoteSsrc, nowMs);
    }
    noteSenderReport(ntpSeconds: number, ntpFraction: number, receivedAtMs = Date.now()) {
        this.receptionStats.setLastSenderReport(ntpSeconds, ntpFraction, receivedAtMs);
    }

    sendFrame(frame: Uint8Array, timestamp90k: number, keyFrame = false): number {
        if (this.closed) throw new Error("Video RTP bridge is closed");
        if (!this.confirmed) return 0;
        // Native RTPSender randomizes the RTP timestamp base; starting near zero
        // leaves the peer's video/audio sync (VideoAudioSync) unable to place
        // frames, so the remote renderer holds them ("Don't render video frame").
        if (this.timestampOffset === undefined) this.timestampOffset = randomBytes(4).readUInt32BE(0);
        timestamp90k = (timestamp90k + this.timestampOffset) >>> 0;
        if (this.packetizer instanceof H264RtpPacketizer) {
            for (const nal of splitH264Nals(frame)) {
                const key = String(nal[0] & 0x1f);
                this.sentH264NalTypes[key] = (this.sentH264NalTypes[key] || 0) + 1;
                this.sentH264NalSamples[key] ||= this.nalSample(nal);
            }
        }
        const packets = this.packetizer.packetize(frame, timestamp90k);
        for (const packet of packets) {
            this.sentOctets += parseRtpPacket(packet).payload.length;
            this.relay.sendVideo(this.protect.protect(packet));
        }
        this.sentPackets += packets.length;
        this.nextSequence = (this.nextSequence + packets.length) & 0xffff;
        this.sentFrameBytes += frame.length;
        this.lastSentTimestamp = timestamp90k;
        this.sentFrames++;
        if (keyFrame) this.sentKeyFrames++;
        return packets.length;
    }

    receiveRtp(encrypted: Uint8Array): boolean {
        if (this.closed) return false;
        if (!this.confirmed) return false;
        let observedPayloadType: number | undefined;
        let observedNalType: number | undefined;
        try {
            if (encrypted.length > 1 && encrypted[0] >>> 6 === 2) {
                const ptKey = String(encrypted[1] & 0x7f);
                this.observedPayloadTypes[ptKey] = (this.observedPayloadTypes[ptKey] || 0) + 1;
            }
            if (encrypted.length < 22 || encrypted[0] >>> 6 !== 2 || !this.receivePayloadTypes.has(encrypted[1] & 0x7f))
                throw new Error("Invalid negotiated video RTP header");
            const ssrc = ((encrypted[8] * 0x1000000) + (encrypted[9] << 16) + (encrypted[10] << 8) + encrypted[11]) >>> 0;
            const ssrcKey = String(ssrc); this.observedSsrcs[ssrcKey] = (this.observedSsrcs[ssrcKey] || 0) + 1;
            if (ssrc !== this.remoteSsrc) {
                if (this.receivedPackets !== 0 || !this.unprotectFactory) throw new Error("Unexpected video SSRC");
                this.unprotect.destroy();
                this.remoteSsrc = ssrc;
                this.unprotect = this.unprotectFactory(ssrc, (encrypted[2] << 8) | encrypted[3]);
            }
            // SRTP uses the explicit sequence seed to estimate ROC. The first
            // observed packet can be later if an initial datagram was lost.
            const clear = this.unprotect.unprotect(encrypted);
            const rtp = parseRtpPacket(clear);
            if (rtp.extension) this.observeHeaderExtension(rtp.extension.profile, rtp.extension.data);
            observedPayloadType = rtp.payloadType;
            observedNalType = rtp.payload[0] & 0x1f;
            const firstKey = `${rtp.payloadType}:${rtp.payload[0]}`;
            this.observedPayloadFirstBytes[firstKey] = (this.observedPayloadFirstBytes[firstKey] || 0) + 1;
            if (!this.receivePayloadTypes.has(rtp.payloadType) || rtp.ssrc !== this.remoteSsrc)
                throw new Error("Video RTP identity changed after SRTP authentication");
            this.receptionStats.update(rtp.sequenceNumber, rtp.timestamp, Date.now());
            // Native Zalo builds have been observed to signal payload 97 as H264
            // while emitting VP8 RFC7741 descriptors (0x10 on a partition start,
            // 0x00 on continuation). Keep H264 for negotiated output, but decode
            // this bounded receive variant so browser video is still delivered.
            const first = rtp.payload[0];
            const vp8Start = Boolean(this.vp8Fallback) && (first === 0x10 || first === 0x90);
            const vp8Continuation = first === 0x00 && this.receiveCodec === "vp8" && rtp.timestamp === this.vp8Timestamp;
            let frame;
            if (!this.vp8Fallback) {
                frame = this.depacketizer.push(clear);
                this.receiveCodec = "vp8";
            } else if (!this.rawH264PacketMode && (vp8Start || vp8Continuation)) {
                this.vp8Timestamp = rtp.timestamp;
                frame = this.vp8Fallback!.push(clear);
                this.receiveCodec = "vp8";
                if (frame) this.vp8Timestamp = undefined;
            } else if (this.rawH264PacketMode || first === 0x00 || this.rawH264Timestamp === rtp.timestamp) {
                // The native packetMode 1 path copies Annex-B bytes verbatim.
                // Some older peers also send Annex-B on an RFC 6184-signaled PT.
                frame = this.pushRawH264(rtp);
                this.receiveCodec = "h264";
            } else {
                frame = this.depacketizer.push(clear);
                this.receiveCodec = "h264";
            }
            this.receivedPackets++;
            if (frame) {
                this.receivedFrames++;
                this.receivedFrameBytes += frame.data.length;
                if (!this.receivedFrameMinBytes || frame.data.length < this.receivedFrameMinBytes)
                    this.receivedFrameMinBytes = frame.data.length;
                if (frame.data.length > this.receivedFrameMaxBytes) this.receivedFrameMaxBytes = frame.data.length;
                if (frame.keyFrame) this.receivedKeyFrames++;
                if (this.receiveCodec === "h264") {
                    for (const nal of splitH264Nals(frame.data)) {
                        const key = String(nal[0] & 0x1f);
                        this.receivedH264NalTypes[key] = (this.receivedH264NalTypes[key] || 0) + 1;
                        this.receivedH264NalSamples[key] ||= this.nalSample(nal);
                    }
                }
                this.onFrame({ ...frame, codec: this.receiveCodec });
            }
            return Boolean(frame);
        } catch (error) {
            this.rejectedPackets++;
            const message = error instanceof Error ? error.message : "unknown";
            this.lastRejection = { message, payloadType: observedPayloadType ?? (encrypted.length > 1 ? encrypted[1] & 0x7f : undefined), nalType: observedNalType };
            const reason = message.includes("negotiated video RTP header") ? "header" :
                message.includes("Unexpected video SSRC") ? "ssrc" :
                message.includes("authentication") || message.includes("replay") ? "srtp" :
                message.includes("H264") ? "h264" : "other";
            this.rejectionReasons[reason] = (this.rejectionReasons[reason] || 0) + 1;
            return false;
        }
    }

    private observeHeaderExtension(profile: number, data: Uint8Array) {
        const profileKey = `0x${profile.toString(16).padStart(4, "0")}`;
        this.observedExtensionProfiles[profileKey] = (this.observedExtensionProfiles[profileKey] || 0) + 1;
        if (profile !== 0xbede) return;
        for (let offset = 0; offset < data.length;) {
            const header = data[offset++];
            if (header === 0) continue;
            const id = header >>> 4;
            if (id === 15) break;
            const length = (header & 0x0f) + 1;
            if (offset + length > data.length) break;
            const value = data.subarray(offset, offset + length);
            const key = `${id}:${length}`;
            this.observedExtensionElements[key] = (this.observedExtensionElements[key] || 0) + 1;
            const sample = Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
            const samples = this.observedExtensionSamples[key] ||= [];
            if (samples.length < 8 && !samples.includes(sample)) samples.push(sample);
            offset += length;
        }
    }

    private nalSample(nal: Uint8Array) {
        return Array.from(nal.subarray(0, Math.min(nal.length, 24)), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    /**
     * Reassemble native raw Annex-B video chunks.
     *
     * Zalo peers put FEC/RTX/auxiliary payloads on the same SSRC and sequence
     * space as the H.264 media payload, and relay packets can arrive out of
     * order. The access unit is therefore locked to the payload type that
     * starts it with an Annex-B prefix, its packets are reordered by RTP
     * sequence number, and the AU is completed when the next timestamp starts.
     */
    private pushRawH264(rtp: ReturnType<typeof parseRtpPacket>) {
        const payload = rtp.payload;
        const startsAccessUnit = payload.length >= 3 && payload[0] === 0 && payload[1] === 0 &&
            (payload[2] === 1 || (payload.length >= 4 && payload[2] === 0 && payload[3] === 1));
        let completed = null;
        if (this.rawH264Timestamp !== undefined && rtp.timestamp !== this.rawH264Timestamp)
            completed = this.finalizeRawH264();
        if (this.rawH264Timestamp === undefined) {
            if (!startsAccessUnit) { this.auxiliaryPackets++; return completed; }
            this.rawH264Timestamp = rtp.timestamp;
            this.rawH264PayloadType = rtp.payloadType;
            this.receivePayloadType = rtp.payloadType;
        }
        if (rtp.payloadType !== this.rawH264PayloadType) {
            // FEC/RTX/auxiliary codec in the same SSRC and sequence space. Its
            // sequence numbers are holes in the media sequence and must not be
            // treated as packet loss when the access unit is finalized.
            this.rawH264AuxSequences.add(rtp.sequenceNumber);
            this.auxiliaryPackets++;
            return completed;
        }
        const sequence = rtp.sequenceNumber;
        if (!this.rawH264Packets.size) {
            this.rawH264FirstSequence = sequence;
            this.rawH264LastSequence = sequence;
        } else {
            let delta = (sequence - this.rawH264FirstSequence) & 0xffff;
            if (delta > 0x8000) { this.rawH264FirstSequence = sequence; delta = 0; }
            if (delta > 0x2000) {
                // Far outside this access unit: treat it as a new frame.
                completed = this.finalizeRawH264();
                this.rawH264Timestamp = rtp.timestamp;
                this.rawH264PayloadType = rtp.payloadType;
                this.rawH264FirstSequence = sequence;
                this.rawH264LastSequence = sequence;
            } else {
                const lastDelta = (sequence - this.rawH264LastSequence) & 0xffff;
                if (lastDelta < 0x8000 && lastDelta > 0) this.rawH264LastSequence = sequence;
            }
        }
        if (!this.rawH264Packets.has(sequence)) {
            this.rawH264Packets.set(sequence, Uint8Array.from(payload));
            this.rawH264Total += payload.length;
        }
        if (this.rawH264Total > 8 * 1024 * 1024) {
            this.resetRawH264();
            throw new RangeError("Raw H264 frame exceeds reassembly bound");
        }
        return completed;
    }

    private finalizeRawH264() {
        const nonEmpty = this.rawH264Packets.size > 0;
        if (!nonEmpty || this.rawH264Timestamp === undefined) { this.resetRawH264(); return null; }
        const span = ((this.rawH264LastSequence - this.rawH264FirstSequence) & 0xffff) + 1;
        let expected = span;
        for (const sequence of this.rawH264AuxSequences) {
            if (((sequence - this.rawH264FirstSequence) & 0xffff) < span) expected--;
        }
        if (this.rawH264Packets.size !== expected) {
            // A packet inside this AU is missing; decoding a truncated H.264
            // access unit only produces decoder errors, so drop it and let the
            // caller request a keyframe.
            this.incompleteAccessUnits++;
            this.resetRawH264();
            return null;
        }
        const data = new Uint8Array(this.rawH264Total + 8);
        let at = 0;
        let fu: Uint8Array | undefined;
        for (let index = 0; index < span; index++) {
            const sequence = (this.rawH264FirstSequence + index) & 0xffff;
            if (this.rawH264AuxSequences.has(sequence)) continue;
            const chunk = this.rawH264Packets.get(sequence);
            if (!chunk) { this.incompleteAccessUnits++; this.resetRawH264(); return null; }
            const nalType = chunk[0] & 0x1f;
            const startsWithStartCode = chunk.length >= 3 && chunk[0] === 0 && chunk[1] === 0 &&
                (chunk[2] === 1 || (chunk.length >= 4 && chunk[2] === 0 && chunk[3] === 1));
            if (!startsWithStartCode && (nalType === 28 || nalType === 29)) {
                // FU-A/FU-B fragment of one NAL: rebuild it with a start code.
                const headerOffset = nalType === 29 ? 4 : 2;
                if (chunk.length <= headerOffset) { this.incompleteAccessUnits++; this.resetRawH264(); return null; }
                const start = Boolean(chunk[1] & 0x80);
                const end = Boolean(chunk[1] & 0x40);
                if (start) {
                    fu = new Uint8Array(4 + 1 + chunk.length - headerOffset);
                    fu.set([0, 0, 0, 1, (chunk[0] & 0xe0) | (chunk[1] & 0x1f)], 0);
                    fu.set(chunk.subarray(headerOffset), 5);
                } else if (fu) {
                    const merged = new Uint8Array(fu.length + chunk.length - headerOffset);
                    merged.set(fu, 0);
                    merged.set(chunk.subarray(headerOffset), fu.length);
                    fu = merged;
                } else {
                    this.incompleteAccessUnits++; this.resetRawH264(); return null;
                }
                if (end) { data.set(fu, at); at += fu.length; fu = undefined; }
                continue;
            }
            if (fu) { this.incompleteAccessUnits++; this.resetRawH264(); return null; }
            data.set(chunk, at); at += chunk.length;
        }
        if (fu) { this.incompleteAccessUnits++; this.resetRawH264(); return null; }
        const frameData = data.subarray(0, at);
        const timestamp = this.rawH264Timestamp;
        this.resetRawH264();
        return { data: frameData, timestamp, keyFrame: hasH264KeyFrame(frameData) };
    }

    private resetRawH264() {
        this.rawH264Packets.clear(); this.rawH264AuxSequences.clear(); this.rawH264Total = 0;
        this.rawH264Timestamp = undefined; this.rawH264PayloadType = undefined;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.confirmed = false;
        this.depacketizer.reset();
        this.vp8Fallback?.reset(); this.vp8Timestamp = undefined;
        this.resetRawH264();
        this.protect.destroy();
        this.unprotect.destroy();
    }
}
