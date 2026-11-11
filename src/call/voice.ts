/**
 * Public voice-call API (`zca-js/call`): 1-to-1 Zalo voice calls, incoming and
 * outgoing, with PCM 48 kHz mono in/out. No video, no group calls, no native
 * binaries, no WebRTC dependency.
 */
export { createCallController, CallController } from "./voice/controller.js";
export { VoiceCall } from "./voice/voiceCall.js";
export { CallError } from "./voice/errors.js";
export type { CallErrorCode } from "./voice/errors.js";
export type {
    CallState, EndReason, CallDirection, CallStats, CallLogger, CallControllerOptions,
    IncomingUnsupportedInfo, CallApiLike, CallListenerLike, VoiceCallSignaling,
} from "./voice/types.js";
export { PCM_RATE } from "./voice/pcm.js";
