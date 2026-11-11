import { ZaloCallClient } from "./client.js";

export { ZaloCallClient } from "./client.js";
export { CallStore, restoreIncoming } from "./store.js";
export { CallTransport, GatewayTransport, assertCallTransport } from "./transport.js";
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
 * const call = createZaloCall({ transport }); // app-provided request/event adapter
 * await call.call(peerId);                    // app backend handles signaling
 *                                             // browser media is opened on demand
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
        call: (peerId, callOptions) => client.call(peerId, callOptions),
        callAudio: (peerId) => client.call(peerId, { callType: 1 }),
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
