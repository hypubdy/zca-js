/** Generic call client defaults. */
export const TERMINAL_ACTIONS = new Set(["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"]);
export const initialState = Object.freeze({
    gateway: "disconnected", zalo: "offline", qr: null, call: "idle", direction: null, media: "idle", incoming: null,
    independent: {}, cameraState: null, stats: null, videoClientStats: null, error: null, lastEvent: null,
});
export const defaultOptions = Object.freeze({
    rpcTimeoutMs: 20000, iceTimeoutMs: 10000, reconnectMs: 2000, autoReconnect: true,
    mediaConstraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false },
});
