/**
 * Experimental Zalo ZRTP envelope, independently reconstructed from arm64
 * ZRTPPacket::_buildPacketInternal (0x10015830c) / _parsePacketInternal
 * (0x1001589e8), Desktop 26.10.20. This is not RFC 6189 ZRTP.
 * Type127 in the traced audio sender is selected when P2P is active. Relay
 * audio uses the asymmetric codec in relayMediaPacket.ts instead.
 * Payloads remain opaque: decoding an envelope does not authenticate SRTP.
 */
export const ZRTP_MEDIA_COMMAND = {
    audio: 6, audioRtcp: 7, video: 8, videoRtcp: 9, audioFec: 10,
} as const;

export type ZrtpMediaPacket = {
    kind: "media";
    version: number;
    /** Native object+0x668; bool role in the initializer, preserved as a byte. */
    role: number;
    /** Native object+0x38, supplied as a uint32 by the media initializer. */
    field38: number;
    command: 6 | 7 | 8 | 9 | 10;
    payload: Uint8Array;
};
export type ZrtpP2pPacket = {
    kind: "p2p";
    version: number;
    role: number;
    field38: number;
    command: number;
    subcommand: number;
    field10: number;
    payload: Uint8Array;
};
export type ZrtpControlPacket = {
    kind: "control";
    type: 1 | 2;
    version: number;
    // Keep native field offsets until semantic identities are corroborated.
    field0c: number;
    field10: number;
    field14: number;
    token: number;
    command: number;
    subcommand: number;
    payload: Uint8Array;
};
export type ZrtpPacket = ZrtpMediaPacket | ZrtpP2pPacket | ZrtpControlPacket;

function integer(value: number, max: number, field: string) {
    if (!Number.isInteger(value) || value < 0 || value > max)
        throw new RangeError(`Invalid ${field}`);
    return value;
}
function minimum(bytes: Uint8Array, size: number) {
    if (bytes.length < size) throw new RangeError(`Truncated ZRTP header: need ${size} bytes`);
}
function isMediaCommand(command: number): command is ZrtpMediaPacket["command"] {
    return command >= 6 && command <= 10;
}

/** Strict bounded envelope parser; no networking, native process, or decryption. */
export function decodeZrtpPacket(bytes: Uint8Array): ZrtpPacket {
    minimum(bytes, 1);
    if (bytes.length > 65535) throw new RangeError("ZRTP datagram exceeds research parser limit");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 127) {
        minimum(bytes, 9);
        const base = { version: bytes[1], role: bytes[2], field38: view.getUint32(3, true), command: view.getUint16(7, true) };
        if (isMediaCommand(base.command)) {
            if (bytes.length - 9 > 1400) throw new RangeError("ZRTP media payload exceeds native 1400-byte bound");
            return { ...base, kind: "media", command: base.command, payload: Uint8Array.from(bytes.subarray(9)) };
        }
        minimum(bytes, 14);
        return { ...base, kind: "p2p", subcommand: bytes[9], field10: view.getUint32(10, true), payload: Uint8Array.from(bytes.subarray(14)) };
    }
    if (bytes[0] === 1 || bytes[0] === 2) {
        minimum(bytes, 21);
        return {
            kind: "control", type: bytes[0], version: bytes[1],
            field0c: view.getUint32(2, true), field10: view.getUint32(6, true),
            field14: view.getUint32(10, true), token: view.getUint32(14, true),
            command: view.getUint16(18, true), subcommand: bytes[20], payload: Uint8Array.from(bytes.subarray(21)),
        };
    }
    throw new RangeError(`Unsupported ZRTP envelope type ${bytes[0]}`);
}

/** Builds the recovered envelope only. Control bodies need command-specific negotiation. */
export function encodeZrtpPacket(packet: ZrtpPacket): Uint8Array {
    const headerLength = packet.kind === "control" ? 21 : packet.kind === "media" ? 9 : 14;
    if (!(packet.payload instanceof Uint8Array)) throw new TypeError("Payload must be bytes");
    if (packet.payload.length + headerLength > 65535) throw new RangeError("ZRTP datagram exceeds research parser limit");
    if (packet.kind === "media" && (!isMediaCommand(packet.command) || packet.payload.length > 1400))
        throw new RangeError("Invalid ZRTP media command or payload length");
    if (packet.kind === "p2p" && isMediaCommand(packet.command)) throw new RangeError("Media command requires media header");
    const bytes = new Uint8Array(headerLength + packet.payload.length);
    const view = new DataView(bytes.buffer);
    bytes[1] = integer(packet.version, 255, "version");
    if (packet.kind === "control") {
        if (packet.type !== 1 && packet.type !== 2) throw new RangeError("Invalid control type");
        bytes[0] = packet.type;
        view.setUint32(2, integer(packet.field0c, 0xffffffff, "field0c"), true);
        view.setUint32(6, integer(packet.field10, 0xffffffff, "field10"), true);
        view.setUint32(10, integer(packet.field14, 0xffffffff, "field14"), true);
        view.setUint32(14, integer(packet.token, 0xffffffff, "token"), true);
        view.setUint16(18, integer(packet.command, 65535, "command"), true);
        bytes[20] = integer(packet.subcommand, 255, "subcommand");
    } else {
        bytes[0] = 127;
        bytes[2] = integer(packet.role, 255, "role");
        view.setUint32(3, integer(packet.field38, 0xffffffff, "field38"), true);
        view.setUint16(7, integer(packet.command, 65535, "command"), true);
        if (packet.kind === "p2p") {
            bytes[9] = integer(packet.subcommand, 255, "subcommand");
            view.setUint32(10, integer(packet.field10, 0xffffffff, "field10"), true);
        }
    }
    bytes.set(packet.payload, headerLength);
    return bytes;
}
