/** Recovered input schemas; no answer or media-session generation is implied. */
export type ZrtcAudioCodec = { name: string; payload: number; frmPtime: number; dynamicFptime: number };
/** Video capability advertised in native extendData.video.codec. */
export type ZrtcVideoCodec = { name: string; payload: number };

/** Native capability observed in CallController::_getVideoCodecSupport. */
export const ZRTC_NATIVE_H264_VIDEO_CODEC: ZrtcVideoCodec = Object.freeze({ name: "h264", payload: 97 });

/** Build the bounded video capability portion of extendData from negotiated transport values. */
export function buildZrtcVideoCapabilities(input: {
    srtpMode: number; srtcp: number; packetMode: number; platform?: number; protocol?: number;
    newZrtc?: number; sP2P?: number; gccMode?: number;
}): Record<string, unknown> {
    if (!input || !Number.isInteger(input.srtpMode) || !Number.isInteger(input.srtcp) || !Number.isInteger(input.packetMode))
        throw new TypeError("Video capability transport values must be integers");
    return {
        callType: 1,
        video: { codec: [{ ...ZRTC_NATIVE_H264_VIDEO_CODEC }] },
        newZrtc: Number.isInteger(input.newZrtc) ? input.newZrtc : 0,
        platform: Number.isInteger(input.platform) ? input.platform : 2,
        protocol: Number.isInteger(input.protocol) ? input.protocol : 0,
        packetMode: input.packetMode, gccMode: Number.isInteger(input.gccMode) ? input.gccMode : 0,
        srtpMode: input.srtpMode, sP2P: Number.isInteger(input.sP2P) ? input.sP2P : 0,
        srtcp: input.srtcp, gccAudio: false, gccSVLR: false, gccEarlyCall: false, tpType: 0, spTcp: 0,
    };
}
export type ZrtcIncomingOffer = {
    callId: number;
    uidFrom: string | number;
    uidTo: string | number;
    uidN: string;
    timestamp: string | number;
    platform?: number;
    protocol?: number;
    sessionId: string;
    extendData?: string;
    rtpAddress: string;
    rtcpAddress: string;
    codecs: ZrtcAudioCodec[];
    /** Effective media kind; explicit extendData.callType takes precedence. */
    videoRequested?: boolean;
    /** Explicit call kind from extendData; observed 0 is audio and 1 is video. */
    callType?: number;
    /** Redacted native request flag, distinct from effective call kind. */
    videoEnable?: number;
    /** Redacted scalar video codec hint from extendData, when its shape is known. */
    videoCodecId?: number;
    /** Numeric codec IDs only when extendData.video.codec is an integer array. */
    videoCodecIds?: number[];
    /** Bounded video codec entries when the native capability uses objects. */
    videoCodecs?: ZrtcVideoCodec[];
    servers?: unknown[];
    zrtcConfig?: Record<string, unknown>;
};
export type ZrtcAcceptedAnswer = {
    callerId: string;
    callId: string;
    status: 0;
    codec: string;
    rtpAddress: string;
    rtcpAddress: string;
    session_id: string;
    /** Native serializer field; API compatibility retains session_id as well. */
    session: string;
    extendData: string;
};
/** Native 401 response fields needed to begin the caller-side relay setup. */
export type ZrtcOutgoingPreflight = {
    status: number;
    fromId: number;
    toId: number;
    callId: number;
    sessionId: string;
    protocol: number;
    zrtcConfig: Record<string, unknown>;
    servers: Array<{ rtpAddress: string; rtcpAddress: string; relayTime: number }>;
};
export type ZrtcOutgoingAnswer = {
    callId: number;
    status: number;
    platform: number;
    codecs: ZrtcAudioCodec[];
    extendData?: string;
};
type JsonObject = Record<string, unknown>;
function object(value: unknown, name: string): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
    return value as JsonObject;
}
function json(value: unknown, name: string): unknown {
    if (typeof value !== "string" || value.length > 1024 * 1024) throw new TypeError(`${name} must be bounded JSON text`);
    try { return JSON.parse(value); } catch { throw new TypeError(`${name} contains invalid JSON`); }
}
function text(value: unknown, name: string): string {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
}
function identifier(value: unknown, name: string): string | number {
    if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new TypeError(`${name} must be an integer or decimal string`);
}
function optionalText(value: unknown, name: string): string | undefined {
    return value === undefined ? undefined : text(value, name);
}
function codecInteger(value: unknown, name: string): number {
    // Native Json::Value::get defaults absent integer members to zero.
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
        throw new TypeError(`${name} must be an int32`);
    return value;
}
/**
 * Parse the recovered Zalo PC 401 `/requestcall` response. The native parser
 * reads these values before preparing `CallConfig`; this does not by itself
 * negotiate a codec or authorize sending the second `/request` signal.
 */
export function parseZrtcOutgoingPreflight(value: unknown): ZrtcOutgoingPreflight {
    const input = object(value, "401 response");
    const id32 = (item: unknown, name: string) => {
        if (typeof item !== "number" || !Number.isInteger(item) || item < -0x80000000 || item > 0x7fffffff)
            throw new TypeError(`${name} must be an int32`);
        return item;
    };
    const id = id32(input.id, "id");
    const status = id32(input.status, "status");
    const fromId = id32(input.fromId, "fromId");
    const toId = id32(input.toId, "toId");
    const protocol = id32(input.protocol, "protocol");
    const sessionId = text(input.sessId, "sessId");
    if (!sessionId || sessionId.length > 4096) throw new TypeError("sessId must be non-empty bounded text");
    const zrtcConfig = input.zrtc_config === undefined ? {} : object(input.zrtc_config, "zrtc_config");
    const rawServers = input.servers === undefined ? [] : input.servers;
    if (!Array.isArray(rawServers) || rawServers.length > 64) throw new TypeError("servers must be a bounded array");
    const servers = rawServers.map((item, index) => {
        const server = object(item, `servers[${index}]`);
        const rtpAddress = text(server.rtpaddr, `servers[${index}].rtpaddr`);
        const rtcpAddress = text(server.rtcpaddr, `servers[${index}].rtcpaddr`);
        // Zalo PC 26.10.20 calls jsonGetInt("relayTime", 0) here. Fields
        // named `sent` and `recv` may also be returned by the service, but the
        // native server parser does not use them to construct ZRTPServerInfo.
        const relayTime = codecInteger(server.relayTime, `servers[${index}].relayTime`);
        return { rtpAddress, rtcpAddress, relayTime };
    });
    return { status, fromId, toId, callId: id, sessionId, protocol, zrtcConfig, servers };
}
/** Native `_parseActAnswer`: callId/status at the envelope, codec/extendData/platform in JSON `params`. */
export function parseZrtcOutgoingAnswer(value: unknown): ZrtcOutgoingAnswer {
    const input = object(value, "answer event");
    const int32 = (item: unknown, name: string) => {
        const number = typeof item === "string" && /^-?\d+$/.test(item) ? Number(item) : item;
        if (typeof number !== "number" || !Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
            throw new TypeError(`${name} must be an int32`);
        return number;
    };
    const params = object(json(input.params, "answer params"), "answer params");
    if (typeof params.codec !== "string") throw new TypeError("answer params.codec must be JSON text");
    return { callId: int32(input.callId, "callId"), status: int32(input.status, "status"),
        platform: codecInteger(params.platform, "answer params.platform"),
        codecs: parseZrtcAudioCodecs(params.codec),
        extendData: optionalText(params.extendData, "answer params.extendData") };
}
export function parseZrtcAudioCodecs(encoded: string): ZrtcAudioCodec[] {
    const values = json(encoded, "codec");
    if (!Array.isArray(values) || values.length > 128) throw new TypeError("codec must be a bounded JSON array");
    return values.map(value => {
        const item = object(value, "codec item");
        return { name: text(item.name, "codec.name"), payload: codecInteger(item.payload, "codec.payload"),
            frmPtime: codecInteger(item.frmPtime, "codec.frmPtime"), dynamicFptime: codecInteger(item.dynamicFptime, "codec.dynamicFptime") };
    });
}

/**
 * Desktop parseRequest 0x10001c824: outer data.params is itself JSON text.
 * Strict supported subset: unlike native's silent defaults, missing negotiation
 * fields fail visibly. Session values may contain secrets; never log this object.
 */
export function parseZrtcIncomingOffer(data: unknown): ZrtcIncomingOffer {
    const outer = object(data, "incoming data");
    const params = object(json(outer.params, "params"), "params");
    if (typeof params.id !== "number" || !Number.isInteger(params.id) || params.id < 0 || params.id > 0xffffffff)
        throw new TypeError("params.id must be a uint32 call identifier");
    if (params.servers !== undefined && !Array.isArray(params.servers)) throw new TypeError("params.servers must be an array");
    const video = params.video === undefined ? undefined : object(params.video, "params.video");
    const extendData = optionalText(params.extendData, "extendData");
    let videoCodecId: number | undefined;
    let videoCodecIds: number[] | undefined;
    let videoCodecs: ZrtcVideoCodec[] | undefined;
    let callType: number | undefined;
    if (extendData !== undefined) {
        const capabilities = JSON.parse(extendData) as unknown;
        if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
            const capabilityObject = capabilities as Record<string, unknown>;
            const kind = capabilityObject.callType;
            if (typeof kind === "number" && Number.isInteger(kind) && kind >= 0 && kind <= 0x7fffffff)
                callType = kind;
            const codec = capabilityObject.video;
            if (codec && typeof codec === "object" && !Array.isArray(codec)) {
                const value = (codec as Record<string, unknown>).codec;
                if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff)
                    videoCodecId = value;
                else if (Array.isArray(value))
                    if (value.every(item => typeof item === "number" && Number.isInteger(item)))
                        videoCodecIds = value.slice(0, 16).filter((item): item is number => item >= 0 && item <= 0x7fffffff);
                    else
                        videoCodecs = value.slice(0, 16).filter(item => item && typeof item === "object" && !Array.isArray(item))
                            .map(item => item as Record<string, unknown>)
                            .filter(item => typeof item.name === "string" && item.name.length > 0 && item.name.length <= 64 &&
                                Number.isInteger(item.payload) && Number(item.payload) >= 0 && Number(item.payload) <= 127)
                            .map(item => ({ name: item.name as string, payload: item.payload as number }));
            }
        }
    }
    return {
        callId: params.id,
        uidFrom: identifier(outer.uidFrom, "uidFrom"), uidTo: identifier(outer.uidTo, "uidTo"),
        uidN: text(outer.uidN, "uidN"), timestamp: identifier(outer.ts, "ts"),
        platform: params.platform === undefined ? undefined : codecInteger(params.platform, "platform"),
        protocol: params.protocol === undefined ? undefined : codecInteger(params.protocol, "protocol"),
        sessionId: text(params.sessId, "sessId"), extendData,
        rtpAddress: text(params.rtpIP, "rtpIP"), rtcpAddress: text(params.rtcpIP, "rtcpIP"),
        codecs: parseZrtcAudioCodecs(text(params.codec, "codec")),
        // Some audio offers set params.video.enable while advertising video-capable
        // transport metadata. When callType is present it is the discriminant for
        // this offer: callType 0 is audio, 1 is video. Keep the legacy request bit
        // as a fallback only when the explicit call kind is absent.
        videoRequested: callType === undefined ? video?.enable === 1 : callType === 1,
        callType,
        videoEnable: video?.enable === undefined ? undefined : codecInteger(video.enable, "params.video.enable"),
        videoCodecId,
        videoCodecIds,
        videoCodecs,
        servers: params.servers,
        zrtcConfig: params.zrtc_config === undefined ? undefined : object(params.zrtc_config, "zrtc_config"),
    };
}

/** Construct the recovered accepted-402 body from explicitly selected media state. */
export function buildZrtcAcceptedAnswer(input: {
    offer: ZrtcIncomingOffer;
    codecs: readonly ZrtcAudioCodec[];
    rtpAddress: string;
    rtcpAddress: string;
    capabilities: Record<string, unknown>;
}): ZrtcAcceptedAnswer {
    if (!input || typeof input !== "object") throw new TypeError("Accepted-answer inputs are required");
    if (!input.offer || typeof input.offer !== "object") throw new TypeError("A parsed incoming offer is required");
    if (!Array.isArray(input.codecs) || input.codecs.length === 0 || input.codecs.length > 128)
        throw new RangeError("Accepted answer requires 1..128 negotiated codecs");
    if (typeof input.rtpAddress !== "string" || !input.rtpAddress || typeof input.rtcpAddress !== "string" || !input.rtcpAddress)
        throw new TypeError("Selected relay RTP and RTCP addresses are required");
    if (!input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities))
        throw new TypeError("Generated local capabilities are required; incoming extendData must not be copied");
    const codec = input.codecs.map(item => {
        if (!item || typeof item.name !== "string" || !item.name || !Number.isInteger(item.payload) ||
            !Number.isInteger(item.frmPtime) || !Number.isInteger(item.dynamicFptime))
            throw new TypeError("Invalid negotiated audio codec");
        return { name: item.name, payload: item.payload, frmPtime: item.frmPtime, dynamicFptime: item.dynamicFptime };
    });
    return {
        callerId: input.offer.uidN,
        callId: String(input.offer.callId),
        status: 0,
        codec: JSON.stringify(codec),
        rtpAddress: input.rtpAddress,
        rtcpAddress: input.rtcpAddress,
        session_id: input.offer.sessionId,
        session: input.offer.sessionId,
        extendData: JSON.stringify(input.capabilities),
    };
}
