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
    extendData?: string;
};

export type RequestOutgoingCallPayload = {
    calleeId: string;
    callId: string;
    /** Zalo Desktop uses 1 for one-to-one audio and 3 for one-to-one video. */
    typeRequest: 1 | 3;
    codec?: string;
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
            const { callerId, callId, status, codec, rtcpAddress, rtpAddress, session_id, extendData } = payload;
            return send("answer", {
                callerId, callId, status, codec: codec || "", rtcpAddress, rtpAddress, session_id,
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
            const { calleeId, callId, rtcpAddress, rtpAddress, codec, session, extendData } = payload;
            return send("request", {
                calleeId, rtcpAddress, rtpAddress, codec, session, callId, imei: ctx.imei,
                ...(extendData ? { extendData, subCommand: 3 } : {}),
            });
        },
        async cancel(callerId: string, callId: string, callType: number) {
            validate(callerId, callId);
            if (!Number.isInteger(callType)) throw new ZaloApiError("Invalid call type");
            return send("cancel", { callerId, callId, callType, status: 0, imei: ctx.imei });
        },
        async end(uidTo: string, callId: string) {
            validate(uidTo, callId);
            return send("endcall", { uidTo, callId, status: 3, imei: ctx.imei });
        },
    };
});
