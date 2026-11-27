# zca-js voice call API (`zca-js/call`, `zca-js/call-webrtc`)

Status: **experimental, not yet live-verified** (see "Verification" below).
Scope: 1-to-1 **voice** calls, incoming and outgoing, and 1-to-1 **video**
calls (H.264, opt-in, see "Video"). No group calls.
Runs on Node ≥ 20, macOS and Linux x64; no native binary, no CoreAudio.

```js
const { createCallController } = require("zca-js/call"); // or import

const calls = createCallController({ api, listener: api.listener, logger, ringTimeoutMs: 60_000 });
calls.on("incoming", async (call) => { call.on("audio", play); await call.answer(); });
calls.on("incoming-unsupported", ({ peerId, callId, kind }) => {}); // video/group: ignored
const call = await calls.dial(peerId);
call.writeAudio(int16Mono48k);
call.on("ended", ({ reason, durationMs }) => {});
await calls.destroy();
```

Optional browser bridge (needs `npm i @roamhq/wrtc`):

```js
const { createWebRtcBridge } = await import("zca-js/call-webrtc");
const bridge = createWebRtcBridge({ iceServers });
const answer = await bridge.accept(browserOffer); // complete SDP (ICE gathered)
bridge.attach(call);                               // before or after call.answer()
bridge.close();                                    // does not hang up the call
```

## Video (experimental)

```js
const calls = createCallController({ api, listener: api.listener, video: true }); // accept video offers
calls.on("incoming", call => { if (call.video) { /* show camera UI */ } call.answer(); });
const call = await calls.dial(peerId, { video: true });     // requestcall typeRequest 3

call.writeVideo(annexB, { timestamp90k, keyFrame });        // encoded H.264 access unit in
call.on("video", ({ data, timestamp, keyFrame }) => {});    // Annex-B access unit out (starts at a keyframe)
call.on("keyframe-request", () => encoder.forceKeyFrame()); // peer sent RTCP PLI/FIR
call.requestKeyFrame();                                     // send PLI (e.g. after a decoder error)
call.setCameraEnabled(false);                               // /conf isOnCam 0 + drop frames
call.on("remote-camera", on => {});                         // peer onoff_camera (field name provisional)
```

The library does not encode or decode video: bring Annex-B H.264 (SPS/PPS
in-band before each IDR, Constrained Baseline recommended), e.g. browser
WebCodecs `VideoEncoder` with `avc: { format: "annexb" }`. Audio works exactly
as in a voice call. Without `video: true` video offers are still reported as
`incoming-unsupported`. If the peer answers a video dial audio-only,
`diagnostics().videoNegotiated` is false and `writeVideo` returns 0.

| Step | Zalo signaling / media | Confidence |
| --- | --- | --- |
| offer/answer | `extendData.callType: 1`, `video.codec: [{name:"h264",payload:97}]` | live-observed offers |
| camera state | `/api/voicecall/conf` `{isOnCam, isOnMic:-1}` after connect (and on toggle) + relay 0x20/0x07, 0x20/0x11 | static RE; `/conf` accepted live 2026-10-25 |
| media | relay type13 out / type14 in, type15 RTCP; own SRTP/SRTCP contexts, same key; SSRC = call user id | inbound decoded live 2026-10-25 |
| packetization | `nal-annexb` for packetMode 2 (default), `balanced` for 1; override `videoPacketFormat` | outbound **not yet live-confirmed** |
| receive | AU locked to the PT that starts with Annex-B; PT98 aux skipped; incomplete AU → PLI | live-observed |
| RTCP | SR+SDES every 1 s; PLI at start until the first IDR arrives, then on loss | |
| cancel | `/cancel` with `callType` 3 | provisional |

## Options beyond the contract

| Option / field | Meaning |
| --- | --- |
| `createCallController({ sendRinging })` | Default `true`: send `ringring` (407) for supported incoming voice calls, like Zalo Desktop. Never sent for ignored (video/group) calls. |
| `call.stats().remoteMuted` | `true` after the peer sent `mute_audio`. Distinguishes "peer is muted" from "we decode silence". |
| `call.on("remote-mute", (muted) => {})` | Fires when `remoteMuted` changes. |
| `createCallController({ video, videoPacketFormat })` | Accept video offers; force `"nal"`/`"balanced"`/`"rfc6184"` outgoing H.264 packetization. |
| `createCallController({ videoRequestEnable })` | Default `true`: outgoing video `/request` carries `video: { enable: 1 }` like native callers (the callee arms its video leg from it). `false` reproduces the pre-2026-11-27 request. |
| `call.stats().video` | `framesSent/keyFramesSent/framesReceived/keyFramesReceived/incompleteFrames/remoteCameraOff`. |
| `call.diagnostics()` | Transport counters (relay packets in, SRTP rejects, wrong SSRC/PT, decode failures, RTCP). No secrets. |

## Protocol mapping

| Contract | Zalo signaling | Confidence |
| --- | --- | --- |
| incoming | listener control `request` (audio when `extendData.callType` is 0) | live-observed offers |
| `answer()` | relay register (callee, cmd 12) → `/answer` status 0 (resent every 3 s, max 5) → wait `answerack` | static RE; ACK path not yet live-confirmed for the independent engine |
| `reject()` / hangup while ringing | `/answer` status **3** | static RE (`UiAnswerCallEvent` 0x1000c8e6c) |
| `dial()` | `/requestcall` (401) → relay register (caller, cmd 11) → `/request` (416) | outgoing connect live-observed 2026-10-25 |
| ringing | control `ringring`/`ringing` | live-observed |
| connected | outgoing: `answer` status 0 → `/answerack` sent; incoming: `answerack` received | |
| hangup (connected) | `/endcall` (status 3) + relay command 3 | |
| hangup (outgoing, before connect) | `/cancel` | |
| remote-hangup | control `endcall` / `end_call` / `end` / `cancel` after answer | |
| cancelled | control `cancel`/`endcall`/… while still `incoming` | |
| rejected (outgoing) | `answer` with status 3 | static RE |
| **busy** | **PROVISIONAL**: produced only locally (`dial()` while a call is active throws `CallError("busy")`). No remote busy status code is confirmed; unknown answer statuses end with reason `"error"` and log the raw `status` at debug level. | needs live trace |
| **answered-elsewhere** | **PROVISIONAL**: `answer`/`answerack` control for an incoming call this controller did not answer (status 3 there → `"rejected"`). | needs live trace |
| network | listener `closed` or `disconnected` | |
| no-answer | outgoing not answered within `ringTimeoutMs` (sends `/cancel`); incoming safety net after `ringTimeoutMs + 30 s` | |

## Media

- Opus via `opusscript` (libopus WASM). Incoming: first offered codec among
  `opus/16000/1` (PT112) and `opus/48000/2` (PT113). Outgoing offers `opus/16000/1`.
- RTP clock = codec sample rate (native `RtpTimestampRateHz == SampleRateHz`),
  SSRC = local call user ID, random initial sequence 1..0x7fff.
- SRTP profile 1/2 keyed from `zrtc_config.srtpKey` or the session-ID fallback;
  SRTCP only when both sides negotiate it. noSeq/profile 3 unsupported.
- Frames are sent every 20 ms once connected (native disables DTX/VAD); silence
  is encoded when muted or when no audio is buffered. `writeAudio` buffer is
  bounded to 200 ms (oldest dropped). Compound RTCP SR/RR every 2.5 s.

## Packaging notes

- `dist/` is ESM + CJS (`dist/cjs/**.cjs`) + `.d.ts`. Type declarations are ESM;
  TypeScript projects compiled as CommonJS with `moduleResolution: nodenext`
  should import with `await import()` (runtime `require()` works in plain JS).

## Verification

Offline: `bun run build && npm run test:call` (fake api/listener/relay, real
SRTP + Opus loopback). Live acceptance (contract §4) results are recorded in
`CALL_STREAM_HANDOFF.md`; until then treat tags as pre-release (`-rc.N`).
