import type { ZrtpRelayInit } from "../relayRegistration.js";
import type { ZrtpRelayMedia } from "../relayMediaPacket.js";
import type { AudioRelay } from "./audioSession.js";

export type CallState =
    | "incoming"   // ringing on our side
    | "dialing"    // invite sent, waiting for the peer to ring
    | "ringing"    // peer is ringing
    | "connecting" // answered, relay/SRTP being confirmed
    | "connected"  // two-way media running
    | "ended";

/**
 * Why a call ended.
 *
 * Provisional mappings (not yet confirmed against live Zalo traffic; see
 * docs/call-api.md): `"busy"` is only produced locally today (no answer status
 * code has been confirmed for remote busy) and `"answered-elsewhere"` is
 * inferred when an `answer`/`answerack` control arrives for an incoming call
 * this controller did not answer.
 */
export type EndReason =
    | "local-hangup" | "remote-hangup" | "rejected" | "busy" | "no-answer"
    | "cancelled"
    | "answered-elsewhere"
    | "network" | "error";

export type CallDirection = "incoming" | "outgoing";

export type CallStats = {
    durationMs: number;
    packetsSent: number;
    packetsReceived: number;
    packetsLost: number;
    /** Smoothed RMS (0..1) of audio sent to the peer. */
    inputRms: number;
    /** Smoothed RMS (0..1) of audio decoded from the peer. */
    outputRms: number;
    /**
     * Extension: true after the peer signalled `mute_audio` (and until it
     * signals unmute). Distinguishes "peer muted" from "we decode silence".
     */
    remoteMuted: boolean;
};

export type CallLogger = {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
};

/** The subset of `api.voiceCall` the controller uses. */
export type VoiceCallSignaling = {
    ring(callerId: string, callId: string): Promise<unknown>;
    answer(payload: { callerId: string; callId: string; status: number; codec?: string; rtcpAddress?: string;
        rtpAddress?: string; session_id?: string; session?: string; extendData?: string }): Promise<unknown>;
    answerAck(calleeId: string, callId: string): Promise<unknown>;
    requestCall(payload: { calleeId: string; callId: string; typeRequest: 1 | 3; codec?: string }): Promise<unknown>;
    request(payload: { calleeId: string; callId: string; rtcpAddress: string; rtpAddress: string; codec: string;
        session: string; extendData?: string }): Promise<unknown>;
    cancel(callerId: string, callId: string, callType: number): Promise<unknown>;
    end(uidTo: string, callId: string): Promise<unknown>;
};

/** Minimal listener surface: `api.listener` satisfies it. */
/* eslint-disable @typescript-eslint/no-explicit-any -- must accept zca-js Listener's typed overloads */
export type CallListenerLike = {
    on(event: string, handler: (...args: any[]) => void): unknown;
    off(event: string, handler: (...args: any[]) => void): unknown;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Minimal API surface: a logged-in zca-js `API` satisfies it. */
export type CallApiLike = { voiceCall: VoiceCallSignaling };

/** @internal Transport factory, replaceable in tests. */
export type OpenRelay = (init: ZrtpRelayInit, relay: { address: string; port: number },
    handlers: { onMedia: (packet: ZrtpRelayMedia) => void; onError: (error: Error) => void }) => Promise<AudioRelay>;

export type CallControllerOptions = {
    api: CallApiLike;
    /** A started listener (normally `api.listener`). The controller adds its own handlers. */
    listener: CallListenerLike;
    logger?: CallLogger;
    /** Outgoing call not answered within this time → ended "no-answer". Default 60 000. */
    ringTimeoutMs?: number;
    /**
     * Send `ringring` (407) for supported incoming voice calls, like Zalo
     * Desktop does. Never sent for ignored (video/group) calls. Default true.
     */
    sendRinging?: boolean;
    /** @internal Test hook: replaces the UDP relay transport. */
    openRelay?: OpenRelay;
    /** @internal Test hook: connection (answer → ACK) timeout. Default 20 000. */
    connectTimeoutMs?: number;
};

export type IncomingUnsupportedInfo = { peerId: string; callId: string; kind: "video" | "group" };
