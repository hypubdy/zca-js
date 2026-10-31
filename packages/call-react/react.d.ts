import type { ZaloCallClient, ZaloCallClientOptions, ZaloCallState } from "./index.js";

export interface UseZaloCallResult {
    state: ZaloCallState;
    client: ZaloCallClient;
    call(calleeId: string, options?: { callType?: 1 | 3 }): ReturnType<ZaloCallClient["call"]>;
    /** Audio call shortcut; microphone and speakers are prepared automatically. */
    callAudio(calleeId: string): ReturnType<ZaloCallClient["call"]>;
    answer(): ReturnType<ZaloCallClient["answer"]>;
    hangup(): ReturnType<ZaloCallClient["hangup"]>;
    setMicrophoneMuted(muted: boolean): void;
    setMuted(muted: boolean): void;
    setPlaybackMuted(muted: boolean): void;
    setVolume(volume: number): void;
    connected: boolean;
    online: boolean;
    inCall: boolean;
}

export declare function useZaloCall(options?: ZaloCallClientOptions): UseZaloCallResult;

/** Alias kept for applications that prefer the shorter name. */
export declare const useCall: typeof useZaloCall;
