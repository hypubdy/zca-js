import type { CallClientOptions, CallStateSnapshot, ZaloCallClient } from "./index.js";
export interface UseCallResult {
    state: CallStateSnapshot;
    client: ZaloCallClient;
    call(peerId: string, options?: { callType?: 1 | 3 }): Promise<unknown>;
    callAudio(peerId: string): Promise<unknown>;
    answer(): Promise<unknown>;
    hangup(): Promise<unknown>;
    setMicrophoneMuted(muted: boolean): void;
    setMuted(muted: boolean): void;
    setPlaybackMuted(muted: boolean): void;
    setVolume(volume: number): void;
    connected: boolean;
    online: boolean;
    inCall: boolean;
}
export declare function useCall(options?: CallClientOptions): UseCallResult;
export declare const useZaloCall: typeof useCall;
