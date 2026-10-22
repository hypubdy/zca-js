import { randomBytes } from "node:crypto";

export type ParsedRtpPacket = {
    marker: boolean;
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    csrc: number[];
    extension?: { profile: number; data: Uint8Array };
    headerLength: number;
    paddingLength: number;
    payload: Uint8Array;
};

const uint = (value: number, max: number, name: string) => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid RTP ${name}`);
};

/** Strict RTP v2 parser. Payload is copied so it cannot alias a reused UDP buffer. */
export function parseRtpPacket(packet: Uint8Array): ParsedRtpPacket {
    if (!(packet instanceof Uint8Array) || packet.length < 12) throw new RangeError("RTP packet is shorter than its fixed header");
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if ((packet[0] >>> 6) !== 2) throw new TypeError("Unsupported RTP version");
    const csrcCount = packet[0] & 0x0f;
    let headerLength = 12 + csrcCount * 4;
    if (packet.length < headerLength) throw new RangeError("Truncated RTP CSRC list");
    const csrc: number[] = [];
    for (let i = 0; i < csrcCount; i++) csrc.push(view.getUint32(12 + i * 4, false));
    let extension: ParsedRtpPacket["extension"];
    if (packet[0] & 0x10) {
        if (packet.length < headerLength + 4) throw new RangeError("Truncated RTP extension header");
        const profile = view.getUint16(headerLength, false);
        const extensionLength = view.getUint16(headerLength + 2, false) * 4;
        if (packet.length < headerLength + 4 + extensionLength) throw new RangeError("Truncated RTP extension data");
        extension = { profile, data: Uint8Array.from(packet.subarray(headerLength + 4, headerLength + 4 + extensionLength)) };
        headerLength += 4 + extensionLength;
    }
    const paddingLength = packet[0] & 0x20 ? packet[packet.length - 1] : 0;
    if (paddingLength > packet.length - headerLength) throw new RangeError("Invalid RTP padding length");
    const payloadEnd = packet.length - paddingLength;
    if (payloadEnd <= headerLength) throw new RangeError("RTP payload is empty");
    return {
        marker: Boolean(packet[1] & 0x80), payloadType: packet[1] & 0x7f,
        sequenceNumber: view.getUint16(2, false), timestamp: view.getUint32(4, false),
        ssrc: view.getUint32(8, false), csrc, extension, headerLength, paddingLength,
        payload: Uint8Array.from(packet.subarray(headerLength, payloadEnd)),
    };
}

export type BuildRtpAudioPacket = {
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    payload: Uint8Array;
    marker?: boolean;
};

/** Build an RTP v2 audio packet with no unnegotiated extensions. */
export function buildRtpAudioPacket(input: BuildRtpAudioPacket): Uint8Array {
    uint(input.payloadType, 127, "payload type");
    uint(input.sequenceNumber, 0xffff, "sequence number");
    uint(input.timestamp, 0xffffffff, "timestamp");
    uint(input.ssrc, 0xffffffff, "SSRC");
    if (!(input.payload instanceof Uint8Array) || input.payload.length === 0 || input.payload.length > 1388)
        throw new RangeError("RTP audio payload must be 1..1388 bytes");
    const packet = new Uint8Array(12 + input.payload.length);
    packet[0] = 0x80;
    packet[1] = input.payloadType | (input.marker ? 0x80 : 0);
    const view = new DataView(packet.buffer);
    view.setUint16(2, input.sequenceNumber, false);
    view.setUint32(4, input.timestamp, false);
    view.setUint32(8, input.ssrc, false);
    packet.set(input.payload, 12);
    return packet;
}

export type RtpAudioSenderOptions = {
    ssrc: number;
    payloadType: number;
    clockRate: number;
    /** RTP clock ticks per encoded packet, derived from negotiated codec/frame time. */
    timestampStep: number;
    initialSequenceNumber?: number;
    initialTimestamp?: number;
};

/** Per-call RTP counter state. Callers must create a fresh instance for each call/key. */
export class RtpAudioSender {
    private sequenceNumber: number;
    private timestamp: number;
    private readonly options: RtpAudioSenderOptions;
    constructor(options: RtpAudioSenderOptions) {
        uint(options.ssrc, 0xffffffff, "SSRC");
        uint(options.payloadType, 127, "payload type");
        if (!Number.isInteger(options.clockRate) || options.clockRate < 8000 || options.clockRate > 192000)
            throw new RangeError("RTP clock rate must be 8000..192000 Hz");
        if (!Number.isInteger(options.timestampStep) || options.timestampStep < 1 || options.timestampStep > options.clockRate)
            throw new RangeError("Invalid RTP timestamp step");
        this.options = options;
        this.sequenceNumber = options.initialSequenceNumber ?? randomBytes(2).readUInt16BE(0) % 0x7fff + 1;
        this.timestamp = options.initialTimestamp ?? randomBytes(4).readUInt32BE(0);
        uint(this.sequenceNumber, 0xffff, "sequence number");
        uint(this.timestamp, 0xffffffff, "timestamp");
    }
    packet(encodedOpus: Uint8Array, marker = false): Uint8Array {
        const packet = buildRtpAudioPacket({
            payloadType: this.options.payloadType,
            sequenceNumber: this.sequenceNumber,
            timestamp: this.timestamp,
            ssrc: this.options.ssrc,
            payload: encodedOpus,
            marker,
        });
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
        this.timestamp = (this.timestamp + this.options.timestampStep) >>> 0;
        return packet;
    }
    counters() { return { sequenceNumber: this.sequenceNumber, timestamp: this.timestamp, ssrc: this.options.ssrc }; }
}
