import { randomBytes } from "node:crypto";
import { parseRtpPacket } from "./rtpAudio.js";

const uint = (value: number, max: number, name: string) => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid RTP ${name}`);
};

export type Vp8RtpOptions = { payloadType: number; ssrc: number; initialSequenceNumber?: number; maxPacketSize?: number };

/** Packetizes one encoded VP8 frame as RFC 7741 payloads inside RTP v2 packets. */
export class Vp8RtpPacketizer {
    private sequence: number;
    private readonly payloadType: number;
    private readonly ssrc: number;
    private readonly maxPayload: number;

    constructor(options: Vp8RtpOptions) {
        uint(options.payloadType, 127, "payload type");
        uint(options.ssrc, 0xffffffff, "SSRC");
        const maxPacketSize = options.maxPacketSize ?? 1200;
        if (!Number.isInteger(maxPacketSize) || maxPacketSize < 256 || maxPacketSize > 1385)
            throw new RangeError("RTP video packet size must be 256..1385 bytes to leave room for SRTP and relay headers");
        this.payloadType = options.payloadType;
        this.ssrc = options.ssrc;
        this.sequence = options.initialSequenceNumber ?? randomBytes(2).readUInt16BE(0);
        uint(this.sequence, 0xffff, "sequence number");
        // 12-byte RTP header + one-byte VP8 payload descriptor.
        this.maxPayload = maxPacketSize - 13;
    }

    packetize(frame: Uint8Array, timestamp: number): Uint8Array[] {
        uint(timestamp, 0xffffffff, "timestamp");
        if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 4 * 1024 * 1024)
            throw new RangeError("Encoded VP8 frame must be 1..4194304 bytes");
        const packets: Uint8Array[] = [];
        for (let offset = 0; offset < frame.length;) {
            const size = Math.min(this.maxPayload, frame.length - offset);
            const first = offset === 0;
            const last = offset + size === frame.length;
            const packet = new Uint8Array(13 + size);
            packet[0] = 0x80;
            packet[1] = this.payloadType | (last ? 0x80 : 0);
            const view = new DataView(packet.buffer);
            view.setUint16(2, this.sequence, false);
            view.setUint32(4, timestamp, false);
            view.setUint32(8, this.ssrc, false);
            packet[12] = first ? 0x10 : 0x00; // S=1, PartID=0 on the first fragment.
            packet.set(frame.subarray(offset, offset + size), 13);
            packets.push(packet);
            this.sequence = (this.sequence + 1) & 0xffff;
            offset += size;
        }
        return packets;
    }
}

function vp8DescriptorLength(payload: Uint8Array): { length: number; startsPartition: boolean } {
    if (!payload.length) throw new RangeError("Empty VP8 RTP payload");
    const descriptor = payload[0];
    let offset = 1;
    const startsPartition = Boolean(descriptor & 0x10) && (descriptor & 0x0f) === 0;
    if (descriptor & 0x80) {
        if (offset >= payload.length) throw new RangeError("Truncated VP8 extension flags");
        const flags = payload[offset++];
        if (flags & 0x80) {
            if (offset >= payload.length) throw new RangeError("Truncated VP8 picture id");
            const longPictureId = Boolean(payload[offset] & 0x80);
            offset += longPictureId ? 2 : 1;
            if (offset > payload.length) throw new RangeError("Truncated VP8 picture id");
        }
        if (flags & 0x40) offset++;
        if (flags & 0x30) offset++;
        if (offset > payload.length) throw new RangeError("Truncated VP8 payload descriptor");
    }
    return { length: offset, startsPartition };
}

/** Bounded single-frame VP8 reassembly; drops incomplete or interleaved frames. */
export class Vp8RtpDepacketizer {
    private fragments: Uint8Array[] = [];
    private timestamp: number | undefined;
    private nextSequence: number | undefined;
    private payloadType: number | undefined;
    private ssrc: number | undefined;
    private total = 0;

    push(packet: Uint8Array) {
        const rtp = parseRtpPacket(packet);
        const descriptor = vp8DescriptorLength(rtp.payload);
        const data = rtp.payload.subarray(descriptor.length);
        if (!data.length) throw new RangeError("VP8 RTP payload has no frame data");
        if (descriptor.startsPartition) this.reset();
        if (this.timestamp === undefined) {
            if (!descriptor.startsPartition) return null;
            this.timestamp = rtp.timestamp;
            this.payloadType = rtp.payloadType;
            this.ssrc = rtp.ssrc;
        }
        if (rtp.timestamp !== this.timestamp || rtp.payloadType !== this.payloadType || rtp.ssrc !== this.ssrc ||
            (this.nextSequence !== undefined && rtp.sequenceNumber !== this.nextSequence)) {
            this.reset();
            if (!descriptor.startsPartition) return null;
            this.timestamp = rtp.timestamp;
            this.payloadType = rtp.payloadType;
            this.ssrc = rtp.ssrc;
        }
        this.fragments.push(Uint8Array.from(data));
        this.total += data.length;
        this.nextSequence = (rtp.sequenceNumber + 1) & 0xffff;
        if (this.fragments.length > 4096 || this.total > 4 * 1024 * 1024) {
            this.reset();
            throw new RangeError("VP8 frame exceeds reassembly bound");
        }
        if (!rtp.marker) return null;
        const frame = new Uint8Array(this.total);
        let offset = 0;
        for (const fragment of this.fragments) { frame.set(fragment, offset); offset += fragment.length; }
        const result = { data: frame, timestamp: this.timestamp!, keyFrame: (frame[0] & 0x01) === 0 };
        this.reset();
        return result;
    }

    reset() {
        this.fragments = [];
        this.timestamp = undefined;
        this.nextSequence = undefined;
        this.payloadType = undefined;
        this.ssrc = undefined;
        this.total = 0;
    }
}
