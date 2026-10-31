import { ZaloCallClient } from "./client.js";

export { ZaloCallClient } from "./client.js";
export { CallStore, restoreIncoming } from "./store.js";
export { GatewayTransport } from "./transport.js";
export { CallMediaSession } from "./media.js";
export { createVideoCapture, createVideoDecoder, stopVideoCapture } from "./video.js";
export { initialState, defaultOptions, TERMINAL_ACTIONS } from "./constants.js";
export { websocketUrl, configUrl, requireBrowserUrl } from "./urls.js";

/** Compatibility factory. */
export function createZaloCallClient(options) {
    return new ZaloCallClient(options);
}

/**
 * Minimal façade for application code.
 *
 * ```js
 * const call = createZaloCall();
 * await call.call(friendId);        // gateway session must already be online
 *                                  // microphone + speaker are opened for you
 * call.onState((state) => render(state));
 * await call.hangup();
 * ```
 */
export function createZaloCall(options = {}) {
    const client = new ZaloCallClient(options);
    return {
        client,
        connect: () => client.connect(),
        /** Place an outgoing call; audio is connected automatically. */
        call: (calleeId, callOptions) => client.call(calleeId, callOptions),
        callAudio: (calleeId) => client.call(calleeId, { callType: 1 }),
        answer: () => client.answer(),
        hangup: () => client.hangup(),
        setMuted: (muted) => client.setMicrophoneMuted(muted),
        setVolume: (volume) => client.setVolume(volume),
        onState: (listener) => {
            listener(client.getSnapshot());
            return client.subscribe(() => listener(client.getSnapshot()));
        },
        onEvent: (listener) => client.onEvent(listener),
        get state() {
            return client.getSnapshot();
        },
        destroy: () => client.destroy(),
    };
}
