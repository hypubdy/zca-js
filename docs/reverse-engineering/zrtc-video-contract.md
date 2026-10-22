# ZRTC video path: observed contract and implementation boundary

Target: ZaloCall arm64 Mach-O, SHA-256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.
The binary identity was rechecked with REA on 2026-10-21. REA's Hopper and
Ghidra deep providers were unavailable in this session; function details below
come from the matching saved arm64 disassembly at
`/tmp/zalo-call-analysis/helper-arm64-assembly.txt`. They are static findings,
not a live video-call trace.

## Confirmed packet path

- `Peer::onSendVideoRtp` (`0x1001b4678`) checks the media-transfer state and
  maximum RTP size, initializes a video relay packet with `isRtcp=false`, copies
  the already-formed RTP packet unchanged, then calls `sendMediaPacket`.
- `Peer::onSendVideoRtcp` (`0x1001b493c`) uses the same path with
  `isRtcp=true`, copying an RTCP packet. The relay initializer assigns outer
  type **13** for outgoing video RTP and **15** for outgoing video RTCP; the
  type127 P2P commands are8/9 when P2P is active.
- The legacy builder adds a five-byte header to types13 and15: outer type,
  little-endian token, then the body. The receive parser uses type14 for video
  RTP with a one-byte header and type15 for video RTCP with the token header.
  These directions are asymmetric, as with audio. `src/call/relayMediaPacket.ts`
  now implements this framing, but does not itself validate or decrypt media.
- `Peer::getSRTP` selects a distinct video SRTP transport for relay types13/14;
  type15 uses it only when negotiated RTCP protection is enabled. Video must
  therefore have its own send/receive RTP contexts and SRTCP contexts, not reuse
  audio sequence/replay state.
- `Peer::_initVideoRtpRtcp` sets the video SSRC from
  `CallController::getUserId`; `Peer::getVideoSSRC` returns that same value.
  This build therefore uses the call user ID for video SSRC too. Keep video
  packet-index and crypto state separate from audio even when the SSRC value
  matches; the media relay type identifies the stream.
- The video callback receives encoded RTP bytes from WebRTC's video coding
  module; native capture and `WebRtcVideoCoding` encode before
  `onSendVideoRtp`. Incoming frames pass through the video RTP decoder and
  `IncomingVideoStream` renderer. This adapter currently has neither endpoint.

## Codec observations

`Utility::videoCodecToStr` (`0x100155a7c`) maps the observed native codec IDs:

| ID | Name returned by this build |
|---:|---|
| 1 | VP8 |
| 2 | VP9 |
| 3 | OPEN_H264 |
| 4 | H264 |
| 5 | H265 |

The incoming request parser reads both `params.video.enable == 1` and
`extendData.callType == 1`. They are separate native fields; treating the first
as the sole call-kind discriminator can mislabel audio offers. In the live
offer log on 2026-10-21, `extendData.callType` was `0` while the previous demo
classified `videoRequested` as true from `params.video.enable`. The parser now
uses explicit `callType` when present (`0` audio, `1` video in this observed
contract), and falls back to `params.video.enable` only when `callType` is
absent. `getExtendData` only adds nested `video.codec`
when a local config gate is enabled. The replacement records the effective
redacted `videoRequested`, separate `video.enable`, scalar/list numeric codec IDs,
`callType`, and safe nested codec fields. No successful video offer has been
captured yet; the ID-to-RTP-payload mapping,
profile/packetization parameters, frame size/rate, answer shape, and peer ACK
requirements remain unknown.

The replacement has a bounded VP8 RTP packetizer/depacketizer and a generic
`VideoRtpBridge` that keeps separate injected SRTP contexts, gates TX/RX until
peer confirmation, and uses the type13/type14 relay path. The persistent relay
can send types13/15. Offline fixtures verify packetization, encryption and
reassembly. The bridge is deliberately not activated by `IndependentCall` yet:
the adapter has no verified video payload type, remote SSRC/sequence contract,
or accepted-answer capability shape. Browser WebCodecs and camera UI are also
not connected to this bridge.

## Requirements before enabling a real video answer

1. Capture an authorized incoming video offer and preserve only redacted video
   request/capability fields; establish selected codec ID, payload type, codec
   parameters, packet mode, keyframe/PLI and RTCP requirements.
2. Confirm accepted-answer `callType` and `video.codec` shape from a successful
   peer negotiation. Do not infer them from audio's accepted 402.
3. The reusable video relay leg now has separate SRTP contexts, MTU-aware VP8
   packetizer, depacketizer and frame-loss reset behavior. Use local/remote call
   user IDs for video SSRC and integrate only after payload/sequence and key
   derivation are verified.
4. Connect browser camera capture and WebCodecs only when the offered codec and format are supported.
   Add a negotiated transport from the browser's encoded video frames to the
   relay gateway; decode authenticated incoming frames to the browser. Keep
   audio/video clocks and feedback separate and synchronize only after a
   verified RTCP contract.
5. Runtime prove an owned two-way video call: local camera reaches peer, remote
   camera renders in browser, audio remains duplex, keyframe recovery works,
   both ends can hang up, and a second call starts with fresh crypto state.

Until these checks pass, keep video answer disabled and continue to accept only
the already verified voice offer. The reusable RTP/SRTP bridge is a tested
protocol component, not evidence of an interoperable video call.
