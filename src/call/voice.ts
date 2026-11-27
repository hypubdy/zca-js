/**
 * Public voice-call API (`zca-js/call`): 1-to-1 Zalo voice calls, incoming and
 * outgoing, with PCM 48 kHz mono in/out, plus optional 1-to-1 video with
 * encoded H.264 (Annex-B) in/out. No group calls, no native binaries, no
 * WebRTC dependency.
 */
export { createCallController, CallController } from "./voice/controller.js";
export { VoiceCall } from "./voice/voiceCall.js";
export { CallError } from "./voice/errors.js";
export type { CallErrorCode } from "./voice/errors.js";
export type {
    CallState, EndReason, CallDirection, CallStats, CallLogger, CallControllerOptions,
    IncomingUnsupportedInfo, CallApiLike, CallListenerLike, VoiceCallSignaling, VideoStats,
} from "./voice/types.js";
export type { VideoFrame } from "./voice/videoSession.js";
export type { VideoPacketFormat } from "./voice/negotiate.js";
export { PCM_RATE } from "./voice/pcm.js";
