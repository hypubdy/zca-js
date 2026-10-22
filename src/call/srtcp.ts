import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

type SrtcpKeys = { encryption: Buffer; authentication: Buffer; salt: Buffer };
export type SrtcpOptions = {
    masterKeySalt: Uint8Array;
    profile: 1 | 2;
    direction: "send" | "receive";
    replayWindow?: number;
};

function derive(masterKeySalt: Uint8Array): SrtcpKeys {
    if (!(masterKeySalt instanceof Uint8Array) || masterKeySalt.length !== 30)
        throw new RangeError("SRTCP requires 16 master-key and 14 master-salt bytes");
    const master = Buffer.from(masterKeySalt.subarray(0, 16));
    const deriveLabel = (label: number, length: number) => {
        const iv = Buffer.alloc(16);
        iv.set(masterKeySalt.subarray(16));
        iv[7] ^= label;
        const cipher = createCipheriv("aes-128-ctr", master, iv);
        return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
    };
    try {
        // RFC 3711 key derivation labels 3, 4, and 5 are reserved for SRTCP.
        return { encryption: deriveLabel(3, 16), authentication: deriveLabel(4, 20), salt: deriveLabel(5, 14) };
    } finally { master.fill(0); }
}

function validateCompound(packet: Uint8Array) {
    if (packet.length < 8) throw new RangeError("RTCP compound packet is shorter than 8 bytes");
    let offset = 0;
    while (offset < packet.length) {
        if (packet.length - offset < 4) throw new RangeError("Truncated RTCP header");
        const first = packet[offset];
        if ((first >>> 6) !== 2) throw new TypeError("Invalid RTCP version");
        const packetType = packet[offset + 1];
        if (packetType < 192 || packetType > 223) throw new TypeError("Invalid RTCP packet type");
        const partLength = (new DataView(packet.buffer, packet.byteOffset + offset, packet.byteLength - offset).getUint16(2, false) + 1) * 4;
        if (partLength < 4 || offset + partLength > packet.length) throw new RangeError("Invalid RTCP packet length");
        if (offset === 0 && partLength < 8) throw new RangeError("The first RTCP packet must include a sender SSRC");
        const padded = Boolean(first & 0x20);
        if (padded && offset + partLength !== packet.length) throw new RangeError("Only the final RTCP packet may use padding");
        if (padded) {
            const count = packet[offset + partLength - 1];
            if (!count || count > partLength - 4) throw new RangeError("Invalid RTCP padding");
        }
        offset += partLength;
    }
    if (offset !== packet.length) throw new RangeError("RTCP compound packet has trailing bytes");
}

function rtcpSsrc(packet: Uint8Array): number {
    if (packet.length < 8) throw new RangeError("RTCP packet is shorter than its sender SSRC");
    return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(4, false);
}

function crypt(bytes: Uint8Array, keys: SrtcpKeys, ssrc: number, index: number): Buffer {
    const iv = Buffer.alloc(16);
    iv.set(keys.salt);
    const fields = Buffer.alloc(16);
    fields.writeUInt32BE(ssrc, 4);
    // SRTCP's 31-bit index occupies bits 16..46 in the 48-bit packet index.
    fields.writeUInt32BE(index, 10);
    for (let i = 0; i < iv.length; i++) iv[i] ^= fields[i];
    const cipher = createCipheriv("aes-128-ctr", keys.encryption, iv);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

/** RFC 3711 SRTCP for authenticated profiles 1/2; independent of RTP sequence state. */
export class SrtcpContext {
    private readonly keys: SrtcpKeys;
    private readonly direction: "send" | "receive";
    private readonly window: number;
    private nextIndex = 0;
    private highestIndex: number | null = null;
    private readonly received = new Set<number>();
    private destroyed = false;
    private readonly tagLength = 10; // RTCP auth remains SHA1-80 for SRTP profile 2.

    constructor(options: SrtcpOptions) {
        if (options.profile !== 1 && options.profile !== 2) throw new RangeError("Only authenticated SRTCP profiles 1 and 2 are supported");
        if (options.direction !== "send" && options.direction !== "receive") throw new TypeError("Explicit SRTCP direction required");
        const window = options.replayWindow ?? 1024;
        if (!Number.isInteger(window) || window < 64 || window > 4096) throw new RangeError("Replay window must be 64..4096 packets");
        this.keys = derive(options.masterKeySalt);
        this.direction = options.direction;
        this.window = window;
    }

    private tag(packetAndIndex: Buffer): Buffer {
        return createHmac("sha1", this.keys.authentication).update(packetAndIndex).digest().subarray(0, this.tagLength);
    }

    protect(rtcp: Uint8Array, encrypt = true): Uint8Array {
        if (this.destroyed || this.direction !== "send") throw new Error("SRTCP context cannot send");
        validateCompound(rtcp);
        if (this.nextIndex > 0x7fffffff) throw new Error("SRTCP index exhausted; rekey required");
        const packet = Buffer.from(rtcp);
        const ssrc = rtcpSsrc(packet);
        if (encrypt && packet.length > 8) packet.set(crypt(packet.subarray(8), this.keys, ssrc, this.nextIndex), 8);
        const indexWord = Buffer.alloc(4);
        // Avoid JS bitwise's signed int32 conversion for the E bit.
        indexWord.writeUInt32BE(this.nextIndex + (encrypt ? 0x80000000 : 0));
        const packetAndIndex = Buffer.concat([packet, indexWord]);
        const protectedPacket = Buffer.concat([packetAndIndex, this.tag(packetAndIndex)]);
        this.nextIndex++;
        return protectedPacket;
    }

    unprotect(srtcp: Uint8Array): Uint8Array {
        if (this.destroyed || this.direction !== "receive") throw new Error("SRTCP context cannot receive");
        if (srtcp.length < 8 + 4 + this.tagLength) throw new RangeError("Truncated SRTCP packet");
        const indexOffset = srtcp.length - this.tagLength - 4;
        const view = new DataView(srtcp.buffer, srtcp.byteOffset, srtcp.byteLength);
        const indexWord = view.getUint32(indexOffset, false);
        const index = indexWord & 0x7fffffff;
        if (this.received.has(index) || (this.highestIndex !== null && index <= this.highestIndex - this.window))
            throw new Error("SRTCP replay or packet outside replay window");
        const packetAndIndex = Buffer.from(srtcp.subarray(0, indexOffset + 4));
        const suppliedTag = srtcp.subarray(indexOffset + 4);
        if (!timingSafeEqual(this.tag(packetAndIndex), suppliedTag)) throw new Error("SRTCP authentication failed");
        const packet = Buffer.from(packetAndIndex.subarray(0, indexOffset));
        const ssrc = rtcpSsrc(packet);
        if (indexWord & 0x80000000) packet.set(crypt(packet.subarray(8), this.keys, ssrc, index), 8);
        validateCompound(packet);
        this.highestIndex = Math.max(this.highestIndex ?? index, index);
        this.received.add(index);
        for (const seen of this.received) if (seen <= this.highestIndex - this.window) this.received.delete(seen);
        return packet;
    }

    destroy() {
        this.keys.encryption.fill(0); this.keys.authentication.fill(0); this.keys.salt.fill(0);
        this.received.clear(); this.destroyed = true;
    }
}
