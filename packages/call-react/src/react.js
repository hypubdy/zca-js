import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ZaloCallClient } from "./client.js";

/**
 * React hook for an application-provided call transport. The application owns
 * authentication and server-side account credentials; none are accepted here.
 *
 * ```jsx
 * const { state, call, answer, hangup, setMuted } = useZaloCall();
 * <button onClick={() => call(friendId)}>Call</button>
 * ```
 *
 * Supply a stable `transport` option. The hook opens browser media on demand;
 * authentication and signaling are owned by the application adapter/backend.
 */
export function useCall(options = {}) {
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
            call: (peerId, callOptions) => client.call(peerId, callOptions),
            /** Audio call shortcut: microphone + speakers are set up for you. */
            callAudio: (peerId) => client.call(peerId, { callType: 1 }),
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
        online: state.gateway === "connected",
        inCall: ["preparing", "relay-ready", "inviting", "calling", "ringing", "connecting", "connected", "answering"].includes(state.call),
    };
}

/** Backward-compatible alias. */
export const useZaloCall = useCall;
