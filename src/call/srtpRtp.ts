import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

/** RFC 3711 RTP only, KDR=0, no MKI. This is NOT verified Zalo interoperability. */
export type SrtpRtpKeys = { encryptionKey: Uint8Array; authenticationKey: Uint8Array; salt: Uint8Array };
export type SrtpPacketIndex = { roc: number; sequenceNumber: number; ssrc: number };
const SEQUENCE_SPACE = 65536;

function uint(value: number, max: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid SRTP ${name}`);
}

/** RFC 3711 4.3, labels 0/1/2; returned buffers contain secret material. */
export function deriveSrtpRtpKeys(masterKeySalt: Uint8Array): SrtpRtpKeys {
    if (!(masterKeySalt instanceof Uint8Array) || masterKeySalt.length !== 30) {
        throw new RangeError("SRTP requires 16 master-key and 14 master-salt bytes");
    }
    const master = Buffer.from(masterKeySalt.subarray(0, 16));
    const derive = (label: number, length: number) => {
        const iv = Buffer.alloc(16);
        iv.set(masterKeySalt.subarray(16), 0);
        iv[7] ^= label; // right-aligned label || 48-bit zero, then shifted 16 bits
        const cipher = createCipheriv("aes-128-ctr", master, iv);
        return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
    };
    try {
        return { encryptionKey: derive(0, 16), authenticationKey: derive(1, 20), salt: derive(2, 14) };
    } finally {
        master.fill(0);
    }
}

/**
 * Low-level RFC 3711 4.1.1 transform, also used for published-vector checks.
 * Does not authenticate or track nonce reuse. Use SrtpRtpContext for packets.
 */
export function applySrtpAesCm(payload: Uint8Array, encryptionKey: Uint8Array, salt: Uint8Array,
    context: SrtpPacketIndex): Uint8Array {
    if (encryptionKey.length !== 16 || salt.length !== 14) throw new RangeError("Invalid SRTP session key/salt length");
    if (payload.length > 1048576) throw new RangeError("SRTP AES-CM segment exceeds 65536 blocks");
    uint(context.roc, 0xffffffff, "ROC");
    uint(context.sequenceNumber, 0xffff, "sequence number");
    uint(context.ssrc, 0xffffffff, "SSRC");
    const iv = Buffer.alloc(16);
    iv.set(salt);
    const fields = Buffer.alloc(16);
    fields.writeUInt32BE(context.ssrc, 4);
    fields.writeUInt32BE(context.roc, 8);
    fields.writeUInt16BE(context.sequenceNumber, 12);
    for (let i = 0; i < 16; i++) iv[i] ^= fields[i];
    const cipher = createCipheriv("aes-128-ctr", encryptionKey, iv);
    return Buffer.concat([cipher.update(payload), cipher.final()]);
}

export type SrtpRtpOptions = {
    masterKeySalt: Uint8Array;
    profile: 1 | 2;
    direction: "send" | "receive";
    ssrc: number;
    /** Explicit expected first packet context; never assume ROC when joining a stream. */
    initialRoc: number;
    initialSequenceNumber: number;
    replayWindow?: number;
    /** Native Zalo noSeq is nonstandard and intentionally unsupported. */
    noSeq?: number;
};

/**
 * One SSRC, one direction, one key lifetime. Sender requires increasing indices;
 * receiver authenticates before committing ROC/replay state. Never share sender
 * key+SSRC with another context or reset it to reuse indices under the same key.
 * No SRTCP, DTLS, MKI, KDR refresh, or native Zalo noSeq compatibility.
 */
export class SrtpRtpContext {
    readonly interoperability = "rfc3711-offline-tested-zalo-unverified" as const;
    private readonly keys: SrtpRtpKeys;
    private readonly direction: "send" | "receive";
    private readonly ssrc: number;
    private readonly initialIndex: number;
    private readonly window: number;
    private readonly tagLength: number;
    private highestIndex: number | null = null;
    private readonly received = new Set<number>();
    private destroyed = false;

    constructor(options: SrtpRtpOptions) {
        if (options.profile !== 1 && options.profile !== 2) throw new RangeError("Only authenticated SRTP profiles 1 and 2 are supported");
        if (options.noSeq !== undefined && options.noSeq !== 0) throw new RangeError("Native SRTP noSeq is unsupported");
        if (options.direction !== "send" && options.direction !== "receive") throw new TypeError("Explicit SRTP direction required");
        uint(options.ssrc, 0xffffffff, "SSRC");
        uint(options.initialRoc, 0xffffffff, "initial ROC");
        uint(options.initialSequenceNumber, 0xffff, "initial sequence number");
        const window = options.replayWindow ?? 1024;
        if (!Number.isInteger(window) || window < 64 || window > 4096) throw new RangeError("Replay window must be 64..4096 packets");
        this.keys = deriveSrtpRtpKeys(options.masterKeySalt);
        this.direction = options.direction;
        this.ssrc = options.ssrc;
        this.initialIndex = options.initialRoc * SEQUENCE_SPACE + options.initialSequenceNumber;
        this.window = window;
        this.tagLength = options.profile === 1 ? 10 : 4;
    }

    private parseHeader(packet: Buffer): { length: number; sequenceNumber: number } {
        if (packet.length < 12 || packet[0] >>> 6 !== 2) throw new Error("Invalid RTP header");
        // This RTP-only primitive refuses RTCP and ambiguous mux octets.
        if (packet[1] >= 192 && packet[1] <= 223) throw new Error("SRTCP/RTCP is unsupported by RTP context");
        if (packet.readUInt32BE(8) !== this.ssrc) throw new Error("SRTP SSRC does not match context");
        let length = 12 + (packet[0] & 15) * 4;
        if (packet.length < length) throw new Error("Truncated RTP CSRC list");
        if (packet[0] & 16) {
            if (packet.length < length + 4) throw new Error("Truncated RTP extension header");
            length += 4 + packet.readUInt16BE(length + 2) * 4;
            if (packet.length < length) throw new Error("Truncated RTP extension body");
        }
        return { length, sequenceNumber: packet.readUInt16BE(2) };
    }

    private index(sequenceNumber: number): SrtpPacketIndex & { index: number } {
        const anchor = this.highestIndex ?? this.initialIndex;
        let roc = Math.floor(anchor / SEQUENCE_SPACE);
        const last = anchor % SEQUENCE_SPACE;
        // RFC 3711 Appendix A. Refuse key-lifetime wrap instead of reusing IVs.
        if (last < 32768) {
            if (sequenceNumber - last > 32768) roc--;
        } else if (last - 32768 > sequenceNumber) roc++;
        uint(roc, 0xffffffff, "estimated ROC (rekey required on exhaustion)");
        return { roc, sequenceNumber, ssrc: this.ssrc, index: roc * SEQUENCE_SPACE + sequenceNumber };
    }

    private tag(packet: Buffer, roc: number): Buffer {
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(roc);
        return createHmac("sha1", this.keys.authenticationKey).update(packet).update(counter).digest().subarray(0, this.tagLength);
    }

    private validatePadding(packet: Buffer, headerLength: number): void {
        if (packet[0] & 32) {
            const count = packet[packet.length - 1];
            if (!count || count > packet.length - headerLength) throw new Error("Invalid RTP padding");
        }
    }

    protect(rtp: Uint8Array): Uint8Array {
        if (this.destroyed || this.direction !== "send") throw new Error("SRTP context cannot send");
        const packet = Buffer.from(rtp);
        const header = this.parseHeader(packet);
        const context = this.index(header.sequenceNumber);
        if (this.highestIndex === null && context.index !== this.initialIndex) throw new Error("First sender packet must match explicit initial context");
        if (this.highestIndex !== null && context.index <= this.highestIndex) throw new Error("SRTP sender index reuse or reordering refused");
        this.validatePadding(packet, header.length);
        packet.set(applySrtpAesCm(packet.subarray(header.length), this.keys.encryptionKey, this.keys.salt, context), header.length);
        const result = Buffer.concat([packet, this.tag(packet, context.roc)]);
        this.highestIndex = context.index;
        return result;
    }

    unprotect(srtp: Uint8Array): Uint8Array {
        if (this.destroyed || this.direction !== "receive") throw new Error("SRTP context cannot receive");
        if (srtp.length < 12 + this.tagLength) throw new Error("Truncated SRTP packet");
        const packet = Buffer.from(srtp.subarray(0, srtp.length - this.tagLength));
        const header = this.parseHeader(packet);
        const context = this.index(header.sequenceNumber);
        if (this.received.has(context.index) || (this.highestIndex !== null && context.index <= this.highestIndex - this.window)) {
            throw new Error("SRTP replay or packet outside replay window");
        }
        const tag = srtp.subarray(srtp.length - this.tagLength);
        if (!timingSafeEqual(this.tag(packet, context.roc), tag)) throw new Error("SRTP authentication failed");
        packet.set(applySrtpAesCm(packet.subarray(header.length), this.keys.encryptionKey, this.keys.salt, context), header.length);
        this.validatePadding(packet, header.length);
        this.highestIndex = Math.max(this.highestIndex ?? context.index, context.index);
        this.received.add(context.index);
        for (const index of this.received) if (index <= this.highestIndex - this.window) this.received.delete(index);
        return packet;
    }

    destroy(): void {
        for (const key of Object.values(this.keys)) key.fill(0);
        this.received.clear();
        this.destroyed = true;
    }
}
