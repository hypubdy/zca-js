import { randomBytes } from "node:crypto";
import { parseRtpPacket } from "./rtpAudio.js";

const uint = (value: number, max: number, name: string) => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid RTP ${name}`);
};

export type H264RtpOptions = {
    payloadType: number;
    ssrc: number;
    initialSequenceNumber?: number;
    maxPacketSize?: number;
    /**
     * "zrtp" is the balanced raw chunking used by native packetMode 1.
     * "nal-annexb" keeps every H.264 NAL (with its Annex-B start code) in one
     * packet and falls back to FU-A only for NALs larger than the MTU, which is
     * the shape a live Zalo peer produced under packetMode 2.
     */
    packetization?: "rfc6184" | "zrtp" | "nal-annexb";
    /** RFC 5285 extension block to place before every clear RTP payload. */
    headerExtension?: (timestamp: number, marker: boolean) => { profile: number; data: Uint8Array };
};

/** Split Annex-B, AVCC, or a single-NAL H.264 access unit into NAL units. */
export function splitH264Nals(data: Uint8Array): Uint8Array[] {
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 8 * 1024 * 1024)
        throw new RangeError("Encoded H264 frame must be 1..8388608 bytes");
    const start = (at: number) => data[at] === 0 && data[at + 1] === 0 && data[at + 2] === 1 ? 3 :
        data[at] === 0 && data[at + 1] === 0 && data[at + 2] === 0 && data[at + 3] === 1 ? 4 : 0;
    const first = start(0);
    if (first) {
        const result: Uint8Array[] = [];
        let nalStart = first;
        for (let i = first; i < data.length;) {
            const prefix = start(i);
            if (!prefix) { i++; continue; }
            if (i > nalStart) result.push(Uint8Array.from(data.subarray(nalStart, i)));
            nalStart = i + prefix;
            i = nalStart;
        }
        if (nalStart < data.length) result.push(Uint8Array.from(data.subarray(nalStart)));
        if (result.length && result.every(nal => nal.length > 0)) return result;
    }
    // AVCC access units use a 32-bit big-endian length before every NAL.
    if (data.length >= 4) {
        const result: Uint8Array[] = [];
        let offset = 0;
        while (offset + 4 <= data.length) {
            const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
            offset += 4;
            if (length === 0 || offset + length > data.length) { result.length = 0; break; }
            result.push(Uint8Array.from(data.subarray(offset, offset + length)));
            offset += length;
        }
        if (result.length && offset === data.length) return result;
    }
    return [Uint8Array.from(data)];
}

/** Packetizes one H.264 access unit using RFC 6184 single-NAL and FU-A packets. */
export class H264RtpPacketizer {
    private sequence: number;
    private readonly payloadType: number;
    private readonly ssrc: number;
    private readonly maxPayload: number;
    private readonly maxPacketSize: number;
    private readonly packetization: "rfc6184" | "zrtp" | "nal-annexb";
    private readonly headerExtension?: H264RtpOptions["headerExtension"];
    constructor(options: H264RtpOptions) {
        uint(options.payloadType, 127, "payload type");
        uint(options.ssrc, 0xffffffff, "SSRC");
        const maxPacketSize = options.maxPacketSize ?? 1200;
        if (!Number.isInteger(maxPacketSize) || maxPacketSize < 256 || maxPacketSize > 1385)
            throw new RangeError("RTP video packet size must be 256..1385 bytes");
        this.payloadType = options.payloadType;
        this.ssrc = options.ssrc;
        this.sequence = options.initialSequenceNumber ?? randomBytes(2).readUInt16BE(0);
        uint(this.sequence, 0xffff, "sequence number");
        this.maxPacketSize = maxPacketSize;
        this.maxPayload = maxPacketSize - 12;
        this.packetization = options.packetization ?? "rfc6184";
        this.headerExtension = options.headerExtension;
        if (!["rfc6184", "zrtp", "nal-annexb"].includes(this.packetization))
            throw new RangeError("Invalid H264 packetization mode");
    }
    packetize(frame: Uint8Array, timestamp: number): Uint8Array[] {
        uint(timestamp, 0xffffffff, "timestamp");
        // Reserve room for the RTP header extension when one will be emitted.
        const headerBudget = this.maxPayload - (this.headerExtension ? 24 : 0);
        if (headerBudget < 16) throw new RangeError("RTP payload budget is too small for the header extension");
        if (this.packetization === "zrtp") {
            if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 8 * 1024 * 1024)
                throw new RangeError("Encoded H264 frame must be 1..8388608 bytes");
            if (!(frame[0] === 0 && frame[1] === 0 && (frame[2] === 1 || frame[2] === 0 && frame[3] === 1)))
                throw new RangeError("Native H264 packetization requires Annex-B input");
            // ZaloCall's mode-7 GeneratePackets reserves two bytes from the
            // payload budget, computes the packet count, then balances the raw
            // Annex-B access unit evenly across those packets.
            const extension = this.headerExtension?.(timestamp, false);
            const extensionSize = extension ? 4 + Math.ceil(extension.data.length / 4) * 4 : 0;
            const payloadBudget = this.maxPayload - extensionSize - 2;
            if (payloadBudget < 1) throw new RangeError("Native H264 RTP payload budget is too small");
            const packetCount = Math.ceil(frame.length / payloadBudget);
            const chunkSize = Math.ceil(frame.length / packetCount);
            const packets: Uint8Array[] = [];
            for (let at = 0; at < frame.length; at += chunkSize) {
                const end = Math.min(at + chunkSize, frame.length);
                packets.push(this.build(frame.subarray(at, end), timestamp, end === frame.length));
            }
            return packets;
        }
        const nals = splitH264Nals(frame);
        if (this.packetization === "nal-annexb") {
            const packets: Uint8Array[] = [];
            nals.forEach((nal, nalIndex) => {
                if (!nal.length || !(nal[0] & 0x1f)) throw new RangeError("Invalid H264 NAL unit");
                const lastNal = nalIndex === nals.length - 1;
                const prefixed = new Uint8Array(4 + nal.length);
                prefixed.set([0, 0, 0, 1], 0);
                prefixed.set(nal, 4);
                if (prefixed.length <= headerBudget) {
                    packets.push(this.build(prefixed, timestamp, lastNal));
                    return;
                }
                if (headerBudget < 3) throw new RangeError("RTP packet budget is too small for H264 FU-A");
                const header = nal[0];
                const fuIndicator = (header & 0xe0) | 28;
                const fuType = header & 0x1f;
                const chunk = headerBudget - 2;
                let offset = 1;
                while (offset < nal.length) {
                    const size = Math.min(chunk, nal.length - offset);
                    const start = offset === 1;
                    const end = offset + size === nal.length;
                    const payload = new Uint8Array(size + 2);
                    payload[0] = fuIndicator;
                    payload[1] = fuType | (start ? 0x80 : 0) | (end ? 0x40 : 0);
                    payload.set(nal.subarray(offset, offset + size), 2);
                    packets.push(this.build(payload, timestamp, end && lastNal));
                    offset += size;
                }
            });
            return packets;
        }
        const packets: Uint8Array[] = [];
        nals.forEach((nal, nalIndex) => {
            if (!nal.length || !(nal[0] & 0x1f)) throw new RangeError("Invalid H264 NAL unit");
            const lastNal = nalIndex === nals.length - 1;
            if (nal.length <= headerBudget) {
                packets.push(this.build(nal, timestamp, lastNal));
                return;
            }
            if (headerBudget < 3) throw new RangeError("RTP packet budget is too small for H264 FU-A");
            const header = nal[0];
            const fuIndicator = (header & 0xe0) | 28;
            const fuType = header & 0x1f;
            const chunk = headerBudget - 2;
            let offset = 1;
            while (offset < nal.length) {
                const size = Math.min(chunk, nal.length - offset);
                const start = offset === 1;
                const end = offset + size === nal.length;
                const payload = new Uint8Array(size + 2);
                payload[0] = fuIndicator;
                payload[1] = fuType | (start ? 0x80 : 0) | (end ? 0x40 : 0);
                payload.set(nal.subarray(offset, offset + size), 2);
                packets.push(this.build(payload, timestamp, end && lastNal));
                offset += size;
            }
        });
        return packets;
    }
    private build(payload: Uint8Array, timestamp: number, marker: boolean) {
        const extension = this.headerExtension?.(timestamp, marker);
        if (extension && (!Number.isInteger(extension.profile) || extension.profile < 0 || extension.profile > 0xffff ||
            !(extension.data instanceof Uint8Array) || extension.data.length > 1020))
            throw new RangeError("Invalid RTP header extension");
        const paddedExtensionLength = extension ? Math.ceil(extension.data.length / 4) * 4 : 0;
        const headerLength = 12 + (extension ? 4 + paddedExtensionLength : 0);
        if (headerLength + payload.length > this.maxPacketSize) throw new RangeError("RTP packet exceeds configured video packet size");
        const packet = new Uint8Array(headerLength + payload.length);
        packet[0] = 0x80 | (extension ? 0x10 : 0); packet[1] = this.payloadType | (marker ? 0x80 : 0);
        const view = new DataView(packet.buffer);
        view.setUint16(2, this.sequence, false); view.setUint32(4, timestamp, false); view.setUint32(8, this.ssrc, false);
        if (extension) {
            view.setUint16(12, extension.profile, false);
            view.setUint16(14, paddedExtensionLength / 4, false);
            packet.set(extension.data, 16);
        }
        packet.set(payload, headerLength);
        this.sequence = (this.sequence + 1) & 0xffff;
        return packet;
    }
}

/** Reassembles H.264 single-NAL and FU-A packets into Annex-B access units. */
export class H264RtpDepacketizer {
    private nals: Uint8Array[] = [];
    private fu: Uint8Array[] = [];
    private timestamp?: number;
    private payloadType?: number;
    private ssrc?: number;
    private nextSequence?: number;
    private total = 0;
    push(packet: Uint8Array) {
        const rtp = parseRtpPacket(packet);
        if (this.timestamp === undefined) {
            this.timestamp = rtp.timestamp; this.payloadType = rtp.payloadType; this.ssrc = rtp.ssrc;
        }
        if (rtp.timestamp !== this.timestamp || rtp.payloadType !== this.payloadType || rtp.ssrc !== this.ssrc ||
            (this.nextSequence !== undefined && rtp.sequenceNumber !== this.nextSequence)) { this.reset(); return null; }
        const p = rtp.payload;
        if (!p.length) return null;
        const type = p[0] & 0x1f;
        if (type >= 1 && type <= 23) {
            this.nals.push(Uint8Array.from(p)); this.total += p.length;
        } else if (type === 24 || type === 25) {
            // STAP-A (24) and STAP-B (25) aggregate several NAL units. STAP-B
            // carries a two-byte decoding-order number before the first NAL.
            let offset = type === 25 ? 3 : 1;
            if (type === 25 && p.length < 3) { this.reset(); throw new RangeError("Truncated H264 STAP-B payload"); }
            while (offset + 2 <= p.length) {
                const size = (p[offset] << 8) | p[offset + 1]; offset += 2;
                if (!size || offset + size > p.length) { this.reset(); throw new RangeError("Invalid H264 STAP aggregate"); }
                this.nals.push(Uint8Array.from(p.subarray(offset, offset + size))); this.total += size; offset += size;
            }
            if (offset !== p.length || !this.nals.length) { this.reset(); throw new RangeError("Truncated H264 STAP aggregate"); }
        } else if (type === 28 || type === 29) {
            const fuOffset = type === 29 ? 4 : 2;
            if (p.length < fuOffset + 1) { this.reset(); throw new RangeError(`Truncated H264 FU-${type === 29 ? "B" : "A"} payload`); }
            const start = Boolean(p[1] & 0x80), end = Boolean(p[1] & 0x40);
            if (start) this.fu = [Uint8Array.from([(p[0] & 0xe0) | (p[1] & 0x1f)]), Uint8Array.from(p.subarray(fuOffset))];
            else if (this.fu.length) this.fu.push(Uint8Array.from(p.subarray(fuOffset)));
            else { this.reset(); return null; }
            if (end) { const size = this.fu.reduce((sum, item) => sum + item.length, 0); const nal = new Uint8Array(size); let at = 0; for (const item of this.fu) { nal.set(item, at); at += item.length; } this.nals.push(nal); this.total += size; this.fu = []; }
        } else { this.reset(); throw new RangeError(`Unsupported H264 RTP packetization type ${type}`); }
        this.nextSequence = (rtp.sequenceNumber + 1) & 0xffff;
        if (this.total > 8 * 1024 * 1024 || this.nals.length > 4096) { this.reset(); throw new RangeError("H264 access unit exceeds reassembly bound"); }
        if (!rtp.marker) return null;
        const size = this.nals.reduce((sum, nal) => sum + 4 + nal.length, 0);
        const data = new Uint8Array(size); let at = 0; let keyFrame = false;
        for (const nal of this.nals) { data.set([0, 0, 0, 1], at); at += 4; data.set(nal, at); at += nal.length; keyFrame ||= (nal[0] & 0x1f) === 5; }
        const result = { data, timestamp: this.timestamp!, keyFrame };
        this.reset(); return result;
    }
    reset() { this.nals = []; this.fu = []; this.timestamp = undefined; this.payloadType = undefined; this.ssrc = undefined; this.nextSequence = undefined; this.total = 0; }
}
