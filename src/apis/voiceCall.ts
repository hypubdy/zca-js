import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { apiFactory } from "../utils.js";

/** Media negotiation values must come from a compatible call engine. */
export type AnswerCallPayload = {
    callerId: string;
    callId: string;
    status: number;
    codec?: string;
    rtcpAddress?: string;
    rtpAddress?: string;
    session_id?: string;
    /** Native desktop serializer spells this field `session`; keep both during REST compatibility. */
    session?: string;
    extendData?: string;
};

export type RequestOutgoingCallPayload = {
    calleeId: string;
    callId: string;
    /** Zalo Desktop uses 1 for one-to-one audio and 3 for one-to-one video. */
    typeRequest: 1 | 3;
    codec?: string;
};

/**
 * Local camera/microphone state notification recovered from Zalo Desktop
 * 26.10.20. `ZCallInfo::_handleLocalCameraState` and
 * `ZMessageTransfer::sendOnOffMicCam` (`0x10002f808`) serialize
 * `{ calleeId, callId, isOnCam, isOnMic, data }`, which the desktop HTTP layer
 * sends to `/api/voicecall/conf` (API id 12006). The peer learns about the
 * local camera only from the `onoff_camera` control update produced by that
 * server round-trip.
 */
export type CallCameraStatePayload = {
    /** Remote party of the call; the native serializer names this field calleeId. */
    calleeId: string;
    /** Native serializes this as a JSON integer, but decimal strings are accepted. */
    callId: string | number;
    /** 1 enables the local camera, 0 disables it. */
    isOnCam: 0 | 1;
    /** -1 leaves the peer's microphone state unchanged; 0/1 set it explicitly. */
    isOnMic: -1 | 0 | 1;
    /** Native sends an empty string for ordinary camera toggles. */
    data?: string;
};

/** Media parameters for the second, ringing request in the caller flow. */
export type OutgoingCallMediaRequestPayload = {
    calleeId: string;
    callId: string;
    rtcpAddress: string;
    rtpAddress: string;
    codec: string;
    session: string;
    extendData?: string;
    /**
     * Native callers send `params.video.enable` alongside `extendData`; the
     * callee's request parser reads it to arm the video leg of the call.
     */
    video?: { enable: 0 | 1 };
};

/** Experimental one-to-one signaling recovered from Zalo Desktop 26.10.20. */
export const voiceCallFactory = apiFactory<unknown>()((api, ctx, utils) => {
    const requireId = (value: string, name: string) => {
        if (typeof value !== "string" || !value.trim()) throw new ZaloApiError(`Missing ${name}`);
    };
    const send = async (action: string, params: Record<string, unknown>) => {
        const domain = api.zpwServiceMap.voice_call?.[0];
        if (!domain) throw new ZaloApiError("Voice call service is not available");
        const encrypted = utils.encodeAES(JSON.stringify(params));
        if (!encrypted) throw new ZaloApiError("Failed to encrypt call params");
        return utils.resolve(await utils.request(utils.makeURL(`${domain}/api/voicecall/${action}`, {
            params: encrypted,
        }), { method: "GET" }));
    };
    const validate = (peerId: string, callId: string) => {
        requireId(peerId, "peer id");
        requireId(callId, "call id");
    };

    return {
        /** Acknowledge an incoming request; does not answer or open a microphone. */
        async ring(callerId: string, callId: string) {
            validate(callerId, callId);
            return send("ringring", { callerId, callId, status: 0, imei: ctx.imei });
        },
        /** Send the call engine's answer, including its negotiated media parameters. */
        async answer(payload: AnswerCallPayload) {
            validate(payload.callerId, payload.callId);
            if (!Number.isInteger(payload.status)) throw new ZaloApiError("Invalid answer status");
            const { callerId, callId, status, codec, rtcpAddress, rtpAddress, session_id, session, extendData } = payload;
            const nativeSession = session || session_id;
            return send("answer", {
                callerId, callId, status, codec: codec || "", rtcpAddress, rtpAddress, session_id,
                ...(nativeSession ? { session: nativeSession } : {}),
                ...(extendData ? { extendData, subCommand: 3 } : {}),
            });
        },
        async answerAck(calleeId: string, callId: string) {
            validate(calleeId, callId);
            return send("answerack", { calleeId, callId, status: 0, imei: ctx.imei });
        },
        /**
         * Start the caller-side request phase recovered from Zalo Desktop.
         * This is only preflight: a compatible caller media/relay negotiation
         * must complete before the separate `/request` phase can ring the peer.
         */
        async requestCall(payload: RequestOutgoingCallPayload) {
            validate(payload.calleeId, payload.callId);
            if (payload.typeRequest !== 1 && payload.typeRequest !== 3)
                throw new ZaloApiError("Invalid outgoing call type");
            const { calleeId, callId, typeRequest, codec = "[]" } = payload;
            return send("requestcall", { calleeId, callId, codec, typeRequest, imei: ctx.imei });
        },
        /** Send the caller's negotiated media offer; this is the phase that can ring the peer. */
        async request(payload: OutgoingCallMediaRequestPayload) {
            validate(payload.calleeId, payload.callId);
            for (const [name, value] of Object.entries({
                rtcpAddress: payload.rtcpAddress,
                rtpAddress: payload.rtpAddress,
                codec: payload.codec,
                session: payload.session,
            })) requireId(value, name);
            const { calleeId, callId, rtcpAddress, rtpAddress, codec, session, extendData, video } = payload;
            return send("request", {
                calleeId, rtcpAddress, rtpAddress, codec, session, callId, imei: ctx.imei,
                ...(extendData ? { extendData, subCommand: 3 } : {}),
                ...(video ? { video: { enable: video.enable === 1 ? 1 : 0 } } : {}),
            });
        },
        async cancel(callerId: string, callId: string, callType: number) {
            validate(callerId, callId);
            if (!Number.isInteger(callType)) throw new ZaloApiError("Invalid call type");
            return send("cancel", { callerId, callId, callType, status: 0, imei: ctx.imei });
        },
        /**
         * Notify the peer about the local camera/microphone state.
         *
         * The Zalo Desktop media engine calls this path as soon as local capture
         * actually starts or stops, not only when the user presses the camera
         * button. Without it the remote Zalo client keeps the caller in the
         * camera-off state and does not render video that arrives over RTP.
         */
        async sendOnOffCamMic(payload: CallCameraStatePayload) {
            requireId(payload.calleeId, "peer id");
            const callId = typeof payload.callId === "number" ? String(payload.callId) : payload.callId;
            if (typeof callId !== "string" || !/^-?\d+$/.test(callId))
                throw new ZaloApiError("Invalid call id");
            if (payload.isOnCam !== 0 && payload.isOnCam !== 1)
                throw new ZaloApiError("Invalid isOnCam value");
            if (![-1, 0, 1].includes(payload.isOnMic)) throw new ZaloApiError("Invalid isOnMic value");
            const data = payload.data ?? "";
            if (typeof data !== "string" || data.length > 4096)
                throw new ZaloApiError("Invalid camera-state data");
            return send("conf", {
                calleeId: payload.calleeId,
                callId: payload.callId,
                isOnCam: payload.isOnCam,
                isOnMic: payload.isOnMic,
                data,
            });
        },
        async end(uidTo: string, callId: string) {
            validate(uidTo, callId);
            return send("endcall", { uidTo, callId, status: 3, imei: ctx.imei });
        },
    };
});
