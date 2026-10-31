/** Shared constants for the browser call client. */

/** Call-control actions that end the remote call. */
export const TERMINAL_ACTIONS = new Set([
    "cancel",
    "endcall",
    "end_call",
    "end",
    "group_cancel",
    "group_endcall",
    "group_end_call",
]);

/** Initial observable state of a call client. */
export const initialState = Object.freeze({
    gateway: "disconnected",
    zalo: "offline",
    call: "idle",
    direction: null,
    media: "idle",
    incoming: null,
    independent: {},
    cameraState: null,
    stats: null,
    videoClientStats: null,
    qr: null,
    error: null,
    lastEvent: null,
});

/** Defaults; every field can be overridden through the constructor options. */
export const defaultOptions = Object.freeze({
    rpcTimeoutMs: 20000,
    iceTimeoutMs: 10000,
    reconnectMs: 2000,
    autoReconnect: true,
    mediaConstraints: {
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
        },
        video: false,
    },
});
