import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ZaloCallClient } from "./client.js";

/**
 * React hook for the Zalo call gateway.
 *
 * ```jsx
 * const { state, call, answer, hangup, setMuted } = useZaloCall();
 * <button onClick={() => call(friendId)}>Call</button>
 * ```
 *
 * The hook connects the gateway automatically, prepares the microphone and
 * routes the remote audio to the speakers; no extra media wiring is required.
 */
export function useZaloCall(options = {}) {
    const optionsRef = useRef(options);
    const clientRef = useRef(null);
    if (!clientRef.current) clientRef.current = new ZaloCallClient(optionsRef.current);
    const client = clientRef.current;
    const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

    useEffect(() => {
        client.connect().catch((error) => client.update({ error: error.message }));
        return () => client.disconnect();
    }, [client]);

    const actions = useMemo(
        () => ({
            client,
            connect: () => client.connect(),
            call: (calleeId, callOptions) => client.call(calleeId, callOptions),
            /** Audio call shortcut: microphone + speakers are set up for you. */
            callAudio: (calleeId) => client.call(calleeId, { callType: 1 }),
            answer: () => client.answer(),
            hangup: () => client.hangup(),
            setMicrophoneMuted: (muted) => client.setMicrophoneMuted(muted),
            setMuted: (muted) => client.setMicrophoneMuted(muted),
            setPlaybackMuted: (muted) => client.setPlaybackMuted(muted),
            setVolume: (volume) => client.setVolume(volume),
        }),
        [client],
    );

    return {
        state,
        ...actions,
        connected: state.gateway === "connected",
        online: state.zalo === "online",
        inCall: ["preparing", "relay-ready", "inviting", "calling", "ringing", "connecting", "connected", "answering"].includes(state.call),
    };
}

/** Alias kept for applications that prefer the shorter name. */
export const useCall = useZaloCall;
