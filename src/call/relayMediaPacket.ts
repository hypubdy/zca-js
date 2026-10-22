/**
 * Relay media envelopes, not the type127 P2P envelopes. Native upstream path:
 * Peer::onSendAudioRtp 0x1001b3d7c -> initZRTPPacketAudio 0x100157d50.
 * Builder/parser 0x10015830c / 0x1001589e8 are directionally asymmetric.
 * SRTP and inner RTP/RTCP validation must be done by separate components.
 */
export type ZrtpRelayMediaKind = "audio" | "audioRtcp" | "audioFec" | "video" | "videoRtcp";
export type ZrtpRelayMedia = {
    kind: ZrtpRelayMediaKind;
    /** Only RTCP RX has a token field; audio/FEC RX do not carry it. */
    token?: number;
    payload: Uint8Array;
};
const LIMIT = 1400;
function payload(bytes: Uint8Array, header: number): Uint8Array {
    if (bytes.length < header) throw new RangeError("Truncated relay media envelope");
    if (bytes.length - header > LIMIT) throw new RangeError("Relay media payload exceeds 1400 bytes");
    return Uint8Array.from(bytes.subarray(header));
}

/** Client -> relay: type3 audio RTP, type5 RTCP, type7 audio FEC, type13 video RTP and type15 video RTCP. */
export function encodeZrtpRelayMedia(packet: ZrtpRelayMedia & { token: number }): Uint8Array {
    const type = packet.kind === "audio" ? 3 : packet.kind === "audioRtcp" ? 5 : packet.kind === "audioFec" ? 7 :
        packet.kind === "video" ? 13 : packet.kind === "videoRtcp" ? 15 : undefined;
    if (type === undefined) throw new TypeError("Unsupported relay media kind");
    if (!Number.isInteger(packet.token) || packet.token < 0 || packet.token > 0xffffffff) throw new RangeError("Invalid relay token");
    if (!(packet.payload instanceof Uint8Array) || packet.payload.length > LIMIT) throw new RangeError("Invalid relay payload");
    const bytes = new Uint8Array(5 + packet.payload.length);
    bytes[0] = type;
    new DataView(bytes.buffer).setUint32(1,packet.token,true);
    bytes.set(packet.payload,5);
    return bytes;
}

/** Relay -> client: type4 audio RTP/type7 FEC/type14 video RTP strip1; type5/15 RTCP strip5. */
export function decodeZrtpRelayMedia(bytes: Uint8Array): ZrtpRelayMedia {
    if (bytes.length === 0) throw new RangeError("Empty relay datagram");
    if (bytes[0] === 4 || bytes[0] === 7 || bytes[0] === 14)
        return {kind:bytes[0] === 4 ? "audio" : bytes[0] === 7 ? "audioFec" : "video",payload:payload(bytes,1)};
    if (bytes[0] === 5 || bytes[0] === 15) {
        const body=payload(bytes,5);
        return {kind:bytes[0] === 5 ? "audioRtcp" : "videoRtcp",token:new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(1,true),payload:body};
    }
    throw new RangeError(`Unsupported incoming relay type ${bytes[0]}`);
}
