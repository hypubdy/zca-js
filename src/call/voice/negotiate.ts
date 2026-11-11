import { isIP } from "node:net";
import { buildZrtcAcceptedAnswer, type ZrtcAcceptedAnswer, type ZrtcIncomingOffer, type ZrtcOutgoingAnswer, type ZrtcOutgoingPreflight } from "../negotiation.js";
import { selectZrtcSrtpKey } from "../srtpParameters.js";
import { DEFAULT_OUTGOING_CODEC, selectOpusCodec, type SelectedOpusCodec } from "./opus.js";
import { CallError } from "./errors.js";

/** Negotiated media security for one call. `masterKeySalt` is secret: never log it. */
export type MediaSecurity = {
    masterKeySalt: Uint8Array;
    profile: 1 | 2;
    srtcp: boolean;
    localSsrc: number;
    remoteSsrc: number;
    codec: SelectedOpusCodec;
};

export type RelayEndpoint = { address: string; port: number };

export function asUint32(value: unknown): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number < -0x80000000 || number > 0xffffffff)
        throw new CallError("internal", "Call user id outside the native uint32 range");
    return number >>> 0;
}

export function parseEndpoint(value: string): RelayEndpoint | null {
    const split = value.lastIndexOf(":");
    if (split < 1) return null;
    const address = value.slice(0, split).replace(/^\[|\]$/g, "");
    const port = Number(value.slice(split + 1));
    if (!isIP(address) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { address, port };
}

export function formatEndpoint(endpoint: RelayEndpoint): string {
    return `${endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address}:${endpoint.port}`;
}

function parseObject(text: string | undefined, what: string): Record<string, unknown> {
    if (text === undefined || text === "") return {};
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new CallError("internal", `${what} is not valid JSON`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallError("internal", `${what} is not an object`);
    return value as Record<string, unknown>;
}

/** Native ZRtcConfig reads srtpRTCP as a JSON bool; an absent member is false. */
function localSrtcpFlag(config: Record<string, unknown>): 0 | 1 {
    const value = config.srtpRTCP;
    if (value === undefined || value === false || value === 0) return 0;
    if (value === true || value === 1) return 1;
    throw new CallError("internal", "Unsupported local srtpRTCP value");
}

/**
 * Mirror CallController::parseCallConfig + _parseExtendData: SRTP mode must
 * match on both sides, SRTCP flag must match, noSeq is unsupported.
 */
function negotiateSecurity(input: {
    zrtcConfig: Record<string, unknown>;
    remoteCapabilities: Record<string, unknown>;
    sessionId: string;
    localUid: unknown;
    remoteUid: unknown;
    codec: SelectedOpusCodec;
}): MediaSecurity {
    const local = input.zrtcConfig;
    const remote = input.remoteCapabilities;
    const mode = local.srtpMode;
    if (mode !== 1 && mode !== 2) throw new CallError("internal", "Unsupported SRTP profile in call config");
    if (remote.srtpMode !== mode) throw new CallError("internal", "Peer SRTP profile does not match local profile");
    if (local.srtpNoSeq || local.noSeq) throw new CallError("internal", "SRTP noSeq mode is not supported");
    const localSrtcp = localSrtcpFlag(local);
    const remoteSrtcp = remote.srtcp === undefined ? 0 : remote.srtcp;
    if (remoteSrtcp !== 0 && remoteSrtcp !== 1) throw new CallError("internal", "Invalid peer srtcp capability");
    if (remoteSrtcp !== localSrtcp) throw new CallError("internal", "Peer srtcp capability does not match local config");
    const masterKeySalt = selectZrtcSrtpKey(mode, input.sessionId, typeof local.srtpKey === "string" ? local.srtpKey : "");
    return {
        masterKeySalt, profile: mode, srtcp: localSrtcp === 1,
        localSsrc: asUint32(input.localUid), remoteSsrc: asUint32(input.remoteUid), codec: input.codec,
    };
}

function packetModeOf(config: Record<string, unknown>): number {
    return Number.isInteger(config.packetMode) ? (config.packetMode as number) : 2;
}

// ---------------------------------------------------------------- incoming --

export type IncomingPlan = {
    relay: RelayEndpoint;
    security: MediaSecurity;
    /** Build the accepted-402 body once the relay that actually registered is known. */
    buildAnswer(registered: RelayEndpoint): ZrtcAcceptedAnswer;
};

export function planIncoming(offer: ZrtcIncomingOffer): IncomingPlan {
    const relay = parseEndpoint(offer.rtpAddress);
    if (!relay) throw new CallError("relay-failed", "Offer relay endpoint is not a literal IP address");
    if (offer.rtpAddress !== offer.rtcpAddress)
        throw new CallError("relay-failed", "Offers with separate RTP/RTCP relay endpoints are not supported");
    const codec = selectOpusCodec(offer.codecs);
    if (!codec) throw new CallError("internal", "Offer has no supported Opus codec (opus/16000/1 or opus/48000/2)");
    const local = offer.zrtcConfig || {};
    const remote = parseObject(offer.extendData, "Offer extendData");
    const packetMode = packetModeOf(local);
    if (remote.packetMode !== undefined && remote.packetMode !== packetMode)
        throw new CallError("internal", "Offer packetMode does not match local config");
    const security = negotiateSecurity({
        zrtcConfig: local, remoteCapabilities: remote, sessionId: offer.sessionId,
        localUid: offer.uidTo, remoteUid: offer.uidFrom, codec,
    });
    return {
        relay, security,
        buildAnswer(registered) {
            const address = formatEndpoint(registered);
            // Conservative capability set: relay UDP only, the negotiated SRTP
            // profile/SRTCP flag, no P2P, no congestion-control extensions.
            const capabilities = {
                packetMode, srtpMode: security.profile, srtcp: security.srtcp ? 1 : 0, sP2P: 0,
                gccMode: 0, gccAudio: false, gccSVLR: false, gccEarlyCall: false, tpType: 0, spTcp: 0,
            };
            return buildZrtcAcceptedAnswer({ offer, codecs: [codec.item], rtpAddress: address, rtcpAddress: address, capabilities });
        },
    };
}

// ---------------------------------------------------------------- outgoing --

export type OutgoingPlan = {
    candidates: Array<{ endpoint: RelayEndpoint; rtpAddress: string; rtcpAddress: string }>;
    codec: SelectedOpusCodec;
    capabilities: Record<string, unknown>;
    localUid: number;
    remoteUid: number;
};

export function planOutgoing(preflight: ZrtcOutgoingPreflight): OutgoingPlan {
    if (preflight.status !== 0) throw new CallError("zalo-rejected", `Zalo refused the call (status ${preflight.status})`);
    const local = preflight.zrtcConfig || {};
    if (local.srtpMode !== 1 && local.srtpMode !== 2) throw new CallError("internal", "Call config has no supported SRTP profile");
    if (local.srtpNoSeq || local.noSeq) throw new CallError("internal", "SRTP noSeq mode is not supported");
    const codec = selectOpusCodec([DEFAULT_OUTGOING_CODEC])!;
    const candidates = preflight.servers.slice(0, 8).flatMap(server => {
        const endpoint = parseEndpoint(server.rtpAddress);
        return endpoint ? [{ endpoint, rtpAddress: server.rtpAddress, rtcpAddress: server.rtcpAddress }] : [];
    });
    if (!candidates.length) throw new CallError("relay-failed", "Zalo returned no usable relay candidate");
    const capabilities = {
        callType: 0, newZrtc: Number.isInteger(local.newZrtc) ? local.newZrtc : 0,
        platform: 2, packetMode: packetModeOf(local), gccMode: 0, srtpMode: local.srtpMode, sP2P: 0,
        srtcp: localSrtcpFlag(local), gccAudio: 0, gccSVLR: 0, tpType: 0, spTcp: 0, gccEarlyCall: 0,
    };
    return { candidates, codec, capabilities, localUid: asUint32(preflight.fromId), remoteUid: asUint32(preflight.toId) };
}

/** Security for the caller once the callee's answer (status 0) has arrived. */
export function securityForOutgoingAnswer(preflight: ZrtcOutgoingPreflight, plan: OutgoingPlan, answer: ZrtcOutgoingAnswer): MediaSecurity {
    const codec = selectOpusCodec(answer.codecs);
    if (!codec || codec.name !== plan.codec.name || codec.payloadType !== plan.codec.payloadType)
        throw new CallError("internal", "Peer answered with a codec that was not offered");
    const remote = parseObject(answer.extendData, "Answer extendData");
    return negotiateSecurity({
        zrtcConfig: preflight.zrtcConfig || {}, remoteCapabilities: remote, sessionId: preflight.sessionId,
        localUid: preflight.fromId, remoteUid: preflight.toId, codec: plan.codec,
    });
}
