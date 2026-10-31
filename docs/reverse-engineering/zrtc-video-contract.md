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
| 4 | X264 |
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

## Ghidra confirmation (2026-10-22)

Ghidra 12.1.4 was run against the arm64 slice of the installed ZaloCall
binary. The project was saved under `/tmp/ghidra-project`; the full analysis
hit the configured 240-second limit because the binary is large, but a targeted
decompiler pass completed for these video functions:

- `Peer::onSendVideoRtp` at `0x1001b4678` checks media state and packet size,
  calls `initZRTPPacketVideo(..., isRtcp=false)`, copies the encoded RTP bytes,
  and sends through `sendMediaPacket`.
- `Peer::onSendVideoRtcp` at `0x1001b493c` follows the same path with
  `isRtcp=true`.
- `Peer::_initVideoRtpRtcp` at `0x10019a4d4` sets the video SSRC from
  `CallController::getUserId`, registers `WebRtcVideoCoding` payloads, and
  configures FEC, REMB, bitrate and the video callback.
- `Utility::videoCodecToStr` at `0x100155a7c` confirms IDs 1=VP8, 2=VP9,
  3=OPEN_H264, 4=X264, 5=H265. It also contains group-call variants 0x32,
  0x3c and 0x3d.
- `ZCalleeWindow::btnAcceptVideoClick` at `0x100052d84` confirms a distinct
  native video-answer UI path.

Additional decompiled receive-path details:

- `ZRTPPacket::initZRTPPacketVideo` at `0x100157e10` uses relay type `0x0d`
  for video RTP and `0x0f` for video RTCP. When P2P is active it switches to
  type `0x7f` with inner command `8`/`9`; the RTCP boolean selects the latter
  command/type. The relay token is stored separately from the copied media
  body.
- `VideoRtpRtcp::receiveVideoRtpPacket` at `0x10028e668` parses and validates
  the RTP header, learns the first video SSRC, updates the receive module, and
  forwards the original RTP body to `ViEReceiver::ReceivedRTPPacket`.
- `VideoRtpRtcp::receiveVideoRtcpPacket` at `0x10028e8dc` forwards the body to
  `ViEReceiver::ReceivedRTCPPacket`; this is a real video RTCP path, not merely
  a relay acknowledgement.
- `VideoRtpRtcp::registerSendPayload` at `0x10028e5a8` registers the codec with
  both the RTP sender and `ViEReceiver::SetReceiveCodec`.
- `_maybeResetVideoRtpRtcp` at `0x10019bc18` creates the video RTP/RTCP module
  only when `CallController::isVideoCall()` is true, attaches the payload
  router, sets packet mode, optionally initializes the module, and starts it.
- `webrtc::VCMCodecDataBase::Codec` at `0x1003f94e4` initializes the native
  codec structures with payload defaults: the VP8/VP9/H264 paths use payload
  `100`, H265 uses payload `123`, and the OpenH264 SVC path uses payload `124`.
  These are defaults from the constructor; an actual offer can override them,
  so the browser/gateway must still select the payload from negotiated data.
- `CallController::_getVideoCodecSupport` at `0x100164224`, called by
  `getExtendData`, builds the signaling capability object with the observed
  entry `{ "name": "h264", "payload": 97 }`. This is the payload advertised in
  the JSON capability, distinct from the internal WebRTC codec-constructor
  defaults above. The implementation must preserve that distinction and use
  the negotiated offer value for RTP.

This narrows the remaining work to the negotiated codec payload/parameters,
video key and RTCP contract, and the browser encoded-frame bridge. It does not
prove that a guessed video answer will interoperate with Zalo.

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

The demo now exposes an experimental video answer trial only when the incoming offer
contains an explicit H.264 `{name,payload}` capability. It still requires the normal
relay, SRTP and matching answer ACK gates. A trial answer or local packet round-trip is
not evidence of an interoperable Zalo video call until an owned peer confirms it.

## Reusable H.264 transport added in this repository (2026-10-22)

The source now contains an RFC 6184 packetizer/depacketizer in `src/call/rtpH264.ts`.
It accepts Annex-B, AVCC, and single-NAL access units, emits single-NAL or FU-A RTP
packets with a negotiated payload type, and reassembles authenticated packets back
to bounded Annex-B access units. `VideoRtpBridge` can select `codec: "h264"` while
retaining independent SRTP state and relay type 13/14 handling. This is a protocol
building block only: it does not establish the Zalo answer, derive the native video
keys, provide a browser H.264 encoder/decoder, or prove interoperability with Zalo.

## Browser media bridge implementation (2026-10-22)

The demo now has a low-latency encoded-frame path. `ZaloCallClient.startVideoCapture()`
uses `MediaStreamTrackProcessor` and `VideoEncoder` with H.264 Annex-B output;
`sendVideoFrame()` sends bounded base64 access units over the existing gateway WebSocket.
The server forwards them to `IndependentCall.sendBrowserVideoFrame()`, which uses a
separate H.264 `VideoRtpBridge` and SRTP context. Incoming authenticated frames are
forwarded as `independent-video-frame` events and can be consumed by
`startVideoDecoder()`/`VideoDecoder` in a browser.

This path is connected after an outgoing video preflight (`callType: 3`) or an incoming
offer with an explicit H.264 payload prepares its video bridge. Incoming answer is now
an experimental trial behind the capability/relay/ACK gates. The browser path therefore
provides the actual media plumbing but is not yet proof of a successful Zalo video call.

## Video RTCP feedback (2026-10-22)

The independent path now parses relay video RTCP type 15 and supports RTCP PSFB/PLI
(type 206, FMT 1). It can emit PLI with the video sender/media SSRC pair, keeps video
SRTCP state separate from audio, and forwards peer PLI requests to the browser encoder
so the next camera frame is forced to a keyframe. This addresses GOP-start and packet-loss
recovery; it does not replace a live interop test of the native peer's RTCP policy.

A loopback test now verifies the complete independent H.264 media leg with SRTP:
packetizer → encrypted RTP → bridge relay → authenticated decrypt → depacketizer →
keyframe callback. This proves the local media implementation and crypto state separation;
it is not a Zalo peer interoperability result.

## Blank video and weak-network investigation (2026-10-22)

An audio-connected video call with blank pictures on both sides exposed several
independent defects in the demo. The backend previously broadcast every received
base64 video frame to all WebSocket peers and retained full frame data in its
event history; it also emitted an `independent-video-media` event per RTP packet.
The frame path now targets only the browser that owns the media session, skips a
congested WebSocket, excludes frames from history, and reports video diagnostics
at most once per second. The browser now avoids encoding before call confirmation,
bounds the encoder queue and outbound socket buffer, and forces a keyframe after
confirmation or frame drops.

The React client's `stopVideoCapture()` cleared its decoder reference without
closing or recreating the decoder. The decoder now survives camera teardown and
is reset between calls. It waits for a keyframe, requests PLI while only delta
frames arrive, and reports decoder errors. The simple page shows the camera
stream actually used for a call and separate counters for encoded frames,
gateway frames, outgoing/incoming RTP packets, received keyframes, and displayed remote frames.
Preview-only camera tracks are stopped before joining a call.
An acknowledgement that a local PLI was sent no longer forces another outgoing
camera keyframe; only an incoming peer PLI does so.

The H.264-configured receive bridge can also encounter VP8 RTP payloads. A VP8
start descriptor (`0x10`/`0x90`) was recognized, but subsequent `0x00`
continuation packets were incorrectly fed to the raw H.264 path. The bridge
now keeps the VP8 frame timestamp and routes its continuations to the VP8
depacketizer. That depacketizer drops incomplete frames after a sequence gap
until a new partition start. Offline SRTP tests cover this mixed signaling/RTP
case. Unexpected payload types are counted before rejection so a live capture
can distinguish a missing codec alias from bad SRTP or missing keyframes.

Chrome with a fake camera encoded 26 H.264 frames and decoded a 320×180 image
from them using WebCodecs. This proves browser encode/decode locally; **a live
two-way Zalo video call after these changes has not yet been observed**. The
original gateway process was started before these backend edits and retains an
online Zalo session at port 4317. A current-code gateway has been started on
port 4318 but needs QR login for a valid relay test. In that test, require increasing outgoing RTP,
incoming authenticated RTP, at least one received keyframe, and an increasing
browser rendered-frame counter; audio alone or packets alone do not prove video.

## Video missing in both directions: SSRC and H.264 packetization (2026-10-22)

The latest call was handled by the older gateway process on port 4317. Its final
diagnostics show 2,068 accepted video RTP packets, 367 packets rejected at the
header check, and remote H.264 access units containing SEI/P slices but no
observed IDR. Audio media continued. This is runtime evidence of incoming video
transport, **not** evidence that either peer displayed video. The newer gateway
on port 4318 had no authenticated Zalo session for that call, so its keyframe
recovery and new video diagnostics have not been tested live.

An outgoing SSRC bug was identified in the independent gateway: caller video
RTP and PLI used the callee ID as their sender SSRC. This contradicts the native
`Peer::_initVideoRtpRtcp` disassembly (`0x10019a56c–0x10019a57c`), which passes
`CallController::getUserId()` to `VideoRtpRtcp::setSSRC`. The gateway now uses
the caller ID for outgoing video RTP and PLI, and the callee ID for the expected
remote video SSRC. A regression test checks the exact RTP and RTCP SSRC fields.
This is a plausible cause of the peer rejecting outbound video; it remains to
be verified in a live call.

The installed ZaloCall arm64 binary also has two H.264 RTP formats.
`VideoRtpRtcp::setPacketMode` (`0x10028f1dc`) maps packetMode 1 to WebRTC
packetizer mode 7. `RtpPacketizerH264::GeneratePackets` branches on mode 7 at
`0x1003dabd8`; its `WriteNextPacket` mode-7 branch (`0x1003db62c–0x1003db648`)
copies encoded bytes directly into RTP payloads. The other branch uses
single NAL, STAP-A and FU-A packetization. The bridge now selects direct Annex-B
fragmentation only for negotiated packetMode 1; other modes keep RFC 6184.
Incoming direct Annex-B fragments are reassembled by timestamp and sequence
number, preserving all encoded bytes. Offline SRTP round-trip tests pass in
both formats. The packetMode of the last live call was not retained in the old
gateway's bounded event history, so its actual format is still unknown.

Next live check: log in on the current-code gateway at port 4318, call with
video, then compare `videoPacketMode`, outgoing/incoming packet counts,
`videoObservedPayloadTypes`, `videoRejectReasons`, received keyframes and
browser rendered frames. A peer-side visible image is required to prove the
outgoing direction; a received IDR and increasing rendered frames prove the
incoming direction.

## Native compound RTCP requirement (2026-10-22)

The blank-video call produced one browser PLI request per second but no remote
IDR. Disassembly explains why a standards-shaped standalone PLI was still not
equivalent to ZaloCall. `ModuleRtpRtcpImpl::RequestKeyFrame` at `0x1003eb0cc`
maps request method 0 to RTCP flag `0x20` (PLI) and method 1 to `0x80` (FIR).
The constructor initializes the request method to 0 at `0x1003e9114`, so the
native path uses PLI rather than FIR.

During `VideoRtpRtcp::_create`, ZaloCall calls `SetRTCPStatus(1)` through the
RtpRtcp vtable. In this embedded WebRTC build, mode 1 is compound RTCP.
`RTCPSender::SendRTCP` always enters `SendCompoundRTCP`, and `PrepareReport`
adds the SR/RR and SDES flags before the requested feedback flag. Therefore a
native keyframe request is an RR/SR + SDES + PLI compound packet, not the
12-byte PLI that the demo previously emitted.

The independent gateway now mirrors that behavior. Keyframe requests contain
RR + SDES + PLI, and the active video leg emits a compound Receiver Report once
per second with sequence/loss/jitter and last-SR timing when available. These
reports use relay media type 15 and the negotiated clear/SRTCP policy. Outgoing
frame and keyframe counters are also retained after teardown. This change is
compiled into `dist`, and the current-code gateway is running on port 4318.
It is waiting for a fresh Zalo login and live call for interoperability proof.

## Simple UI live trace: secondary video payload (2026-10-22)

An outgoing video call from `/simple` ran for about 48 seconds. Audio remained
healthy (2,379 authenticated/decoded packets). The browser submitted 1,152
encoded frames including 21 declared keyframes; the gateway emitted 4,597 video
RTP packets. This proves the Simple camera, WebCodecs encoder and browser-to-
gateway path were active even though neither side displayed an image.

The relay returned 490 video packets on one SSRC: 320 used PT97 and were
authenticated, while 170 used PT98 and were rejected by the old fixed payload
allowlist. The accepted stream produced 310 delta frames and no IDR. ZaloCall
registers every candidate video receive codec, while the replacement registered
only selected PT97 plus legacy PT100. The bridge now accepts bounded candidates
97, 98 and 100 in the same authenticated SSRC/sequence space and records clear
payload signatures per PT so the next trace can distinguish H.264, VP8 or a
secondary format.

The trace also retained `packetMode: null`: caller setup built the second video
bridge from preflight configuration instead of the peer's answer capabilities.
Caller answer setup now derives the effective packet mode and advertised H.264
payload from answer `extendData`, applying native's mode-2 fallback on mismatch.
These changes need a new live Simple call; browser smoke validation alone does
not establish media interoperability.

## Outbound blank video: native raw access-unit packetization (2026-10-22)

After accepting PT98, `/simple` rendered the remote picture reliably, but the
remote Zalo client still showed no local picture. Runtime counters ruled out the
camera and encoder: one completed call sent 296 frames, six encoder keyframes
and 1,201 RTP packets. The encoded H.264 NAL inventory included SPS (7), PPS
(8), IDR (5), SEI (6) and P slices (1). A longer active call showed the same
complete NAL set. The failure was therefore downstream of WebCodecs output.

The native `RtpPacketizerH264::GeneratePackets` mode-7 branch at
`0x1003dabd8–0x1003dacd4` does not build single-NAL/STAP-A/FU-A payloads. It
reserves two bytes from its payload budget, calculates the required packet
count, balances the access-unit bytes across equal-sized chunks, and records
raw source offsets/lengths. `WriteNextPacket` at `0x1003db62c–0x1003db648`
copies each chunk directly; the RFC 6184 branches begin at `0x1003db64c`.

Live receive evidence shows that Zalo's mode-2 peer also uses this raw format:
almost every authenticated PT97 payload begins with the Annex-B prefix byte 0,
and earlier captures begin `00 00 01 06`. The replacement had sent RFC 6184
FU-A/STAP-A for mode 2, which explains why the peer received transport packets
but could not feed them to its configured decoder. The outgoing packetizer now
uses the native balanced raw Annex-B path for negotiated modes 1 and 2. A new
live call is required to prove the peer renders the local camera.

## Outbound RTP metadata and camera state (2026-10-23)

`Peer::onSendVideoRtp` (`0x1001b4678`) creates a relay video `ZRTPPacket` with
type 13. `ZRTPPacket::_buildPacketInternal` (`0x10015830c`) proves that relay
serialization is exactly one type byte, the 32-bit relay token in little-endian
order, and the complete protected RTP packet. It does not add the call ID or
role in relay mode. This matches `encodeZrtpRelayMedia`; the relay envelope is
therefore eliminated as the cause of the missing outbound picture.

The native RTP sender registers RapidSync and VideoSvcLayerIdx extensions.
`RTPSender::BuildRTPHeaderExtension` (`0x1003f078c`) serializes RFC 5285 profile
`0xBEDE`, with ID 13 containing seven RapidSync bytes and ID 14 containing seven
SVC bytes. The replacement can now emit the same two-element shape before SRTP
protection and accounts for its 20-byte header cost when splitting raw H.264.
It also records authenticated incoming extension profiles, elements and bounded
samples. A live outgoing call after this change received 1,318 video RTP packets
from the Zalo peer with no RTP header extension at all. Extensions may be a
native-PC sender feature, but they are not required on the peer's reverse leg.

The same trace sent 4,334 protected video RTP packets for 1,067 browser frames,
including 19 SPS/PPS/IDR-bearing keyframes. Incoming video remained healthy:
1,318 packets became 1,242 frames with 42 keyframes. There were no SRTP or H.264
rejections. Transport, key derivation and the raw receive path are therefore
working in both directions at the gateway boundary; peer-side decode remains
the unproven boundary.

Zalo also has an explicit camera-state control path.
`CallController::vidSetLocalSuspendVideo` (`0x1001888f4`) builds a
request-forward packet using
command `0x20`, subcommand `0x11`, and a four-byte little-endian body containing
the suspend boolean and signed 16-bit reason. Its control envelope addresses
the local user and partner rather than carrying the relay media token. The relay
session now exposes `sendVideoSuspend`, and the demo sends `suspended=false,
reason=0` when a video call is confirmed. The next live test must determine
whether this missing camera-on state was why the peer discarded otherwise valid
outbound video.

Follow-up inspection of the native caller path found a second, distinct control
that was still missing. `CallController::vidSetLocalOffCamera` at
`0x1001883dc` calls `initZRTPPacketRequestForward` with subcommand 7 for local
camera state 1 (camera active), subcommand 8 for state 0 (camera off), and a
four-byte little-endian signed reason. `Peer::stopCapture` calls state 1 when
resuming the video capturer, while `vidIsLocalOffCamera` treats states 0 and 2
as off-camera. This state is separate from suspend/resume (`0x20/0x11`): sending
only the latter can leave the remote UI marked camera-off while RTP is flowing.

The outgoing Simple call now sends `0x20/0x07` with reason 0 after the remote
answer ACK, then sends `0x20/0x11` with `suspended=false`, before it notifies the
browser that the video bridge is confirmed. It records the camera-on signal
separately from the suspend signal. This closes a concrete native-control gap;
only a fresh live outgoing video call can establish whether the peer now renders
the image.

For the next trace the bridge additionally retains bounded first-NAL samples
and NAL-type counts independently for sent and received access units. Compare
SPS profile/level bytes and the presence of SEI/SPS/PPS/IDR if the camera-state
control does not make the peer render the browser stream.

The current browser sender now leaves the seven-byte VideoSvcLayerIdx body at
zero. Native `RTPSender::BuildVideoGroupCallExtension`
(`0x1003f0f8c`) zero-fills that body when `SFUExtensionData` is absent. The
previous demo had invented three increasing frame indices despite having no
native SVC metadata; that could label a single-layer H.264 camera stream
incorrectly. The next outgoing call should verify whether the peer now renders
it; this change is based on the native null-metadata path, not live proof.

## Camera state is a server round-trip, not only a relay control (2026-10-25)

The arm64 slice `579026a61c75a967582e5bef56e21b9326254f9541dd552205b6be2616043221`
of `ZaloCall` (`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`)
was re-analyzed with the Ghidra 12.1.4 provider. A separate signaling path exists
that the replacement had never used:

- `zrtc_call::ZCallInfo::_handleLocalCameraState` (`0x1000c1c44`) reacts to the
  media engine's capture state. States 1 and 3 send `isOnCam=1`; states 0 and 2
  send `isOnCam=0`. `isOnMic` is sent as `-1` (leave unchanged) and `data` is
  the empty string.
- `zrtc_call::ZCallInfo::UiOnOffCameraEvent` (`0x1000c9e78`) does the same for
  an explicit UI toggle, again with `isOnMic=-1` and `data=""`.
- `zrtc_call::ZMessageTransfer::sendOnOffMicCam` (`0x10002f808`) and
  `ZMessageSerializer::sendOnOffMicCam` (`0x100026cdc`) serialize exactly
  `{ calleeId, callId, isOnCam, isOnMic, data }` with IPC command `0x2ee6`
  (12006).
- The Electron layer maps command 12006 to
  `GET {voiceCallDomain}/api/voicecall/conf?params=AES(JSON)`; the shipped
  `pc-dist/compact-app-pc` bundle contains
  `sendOnOffCamMic(e,t,n,a,i){..."/api/voicecall/conf"...{calleeId:e,callId:t,isOnCam:n,isOnMic:a,data:i}}`.
- On the receiving side, `ZMessageDeserializer::_parseActPartnerCamEvent`
  (`0x10001d018`) parses an `onoff_camera` control whose `params` JSON carries
  `reason` and `type` (type 1 = camera on). `ZCallInfo::receivePartnerCamEvent`
  (`0x1000cc910`) forwards `type == 1` to
  `ZCallUiManager::partnerCameraStateChange`. The peer therefore learns about
  the caller's camera from the server control update produced by `/conf`, not
  from the relay request-forward packets alone.

The replacement now calls the same endpoint (`voiceCall.sendOnOffCamMic`) after
a call is confirmed, with `isOnCam=1, isOnMic=-1, data=""`, in addition to the
existing relay camera/suspend forwards. This is a static-evidence fix: whether
the Zalo peer now renders the browser camera after receiving `onoff_camera`
still requires the next live outgoing video call. Relevant native strings that
gate rendering include `Don't render video frame`, `Rendered video frame` and
`VideoRtpRtcp::parnerOffCamera` (`0x10028f818`).

Ghidra Evidence IDs for this section: `ev_c0f4c08fdb8ddcb16727627f703b26cab530d2cc0a7b09fedf9ee5283b3ba3d4`
(strings), `ev_1ee1b71e60f395adedd5e26063751c28be6ecd10b92c2b3cd26e33fd6a2b8115`
(serializer), `ev_d0d4b0b3f146c6d1799259a26f958003226c2e5841ff3947d33342f2bcaea6b9`
(transfer), `ev_ec3892b76df957ca87e9cd9e4b720246c5b2827afb7ef5525152821884980671`
(`_handleLocalCameraState`), `ev_a3f2f5497a2960936bc71889230cda424518b3c226d2c253ff187a60b25b522a`
(`UiOnOffCameraEvent`), `ev_7dd0cffd01f3f15a5c8290fde5f8b29f8f179b5dab202ae18254aa17ab32257e`
(incoming parser) and `ev_5bf9a6315086d6509a4e312cd65126412b589c8cae897ca396d0f950f0fe3e85`
(peer state application).

## Live video call trace and receive-path fixes (2026-10-25)

A real outgoing video call from `/simple` connected and ran for about 26
seconds. The gateway retained these counters after teardown:

- Outgoing: 2,451 protected video RTP packets, 622 access units, 12 keyframes;
  sent NAL inventory `{1:610, 5:12, 6:12, 7:12, 8:12}` (P/IDR/SEI/SPS/PPS).
- Incoming: 363 authenticated video RTP packets on one SSRC `198904355`,
  producing 213 access units and 43 keyframes; payload types `97:209` and
  `98:154`; 22 PLIs were sent by the browser because it never decoded a frame.
- Audio: 1,283 Opus packets authenticated and decoded, 1,283 delivered to the
  browser; the media session's `outputRms` was `3.4e-6`, i.e. digital silence
  from the relay. A peer `mute_audio` control arrived at the end of the call, so
  the silence is consistent with a muted remote microphone rather than a local
  decode failure. This remains an inference.
- `/api/voicecall/conf` was accepted (`cameraState.enabled = true`, sent at
  confirmation) but the peer still reported no local picture.

Native comparison via Ghidra 12.1.4 on the same arm64 slice:

- `Peer::_initVideoRtcpRtcp` (`0x10019a4d4`) sets the video SSRC to
  `CallController::getUserId` and registers every `WebRtcVideoCoding` candidate
  codec for both send and receive. Receive demultiplexing happens inside
  `ViEReceiver::ReceivedRTPPacket` by payload type, not by concatenating all
  packets of the SSRC.
- `RtpPacketizerH264::GeneratePackets` mode 7 (`0x1003dabb8`) computes
  `packetCount = ceil(size / (maxPayload - 2))` and `chunk = ceil(size /
  packetCount)`, and `WriteNextPacket` (`0x1003db5dc`) copies those raw bytes
  with no per-packet prefix. The replacement already matched this byte layout.
- The receiver's FEC/auxiliary payloads (PT98 in this trace) share the media
  SSRC and sequence space. Mixing them into the Annex-B access unit corrupts
  frames, which explains the permanent PLI loop.
- Native `RTCPSender` emits a Sender Report while the video sender is active.
  The replacement sent only Receiver Reports.

Changes made:

1. `VideoRtpBridge` raw assembly now locks each access unit to the payload type
   that starts it with an Annex-B prefix. Packets of other payload types are
   counted in `auxiliaryPackets` and ignored; a new access unit may legitimately
   switch payload type when it starts with Annex-B.
2. Video RTCP now carries SR sender info (`ntpSeconds/ntpFraction/rtpTimestamp/
   packetCount/octetCount`) while frames have been sent, and the compound PLI
   includes that SR, matching native `RTCPSender`.
3. The RapidSync/SVC RTP header extension is opt-in (`VIDEO_RTP_EXTENSIONS=1`).
   The live Zalo peer sent no extensions, and an X-bit-unaware receiver would
   shift the payload; the next live call should run with extensions off first.
4. Outgoing call teardown now uses `endcall` once the call is confirmed instead
   of the previous inverted `cancel` branch.
5. `/api/voicecall/conf` result handling now treats a non-zero `error_code` as a
   failed camera-state signal instead of silently marking it sent.

Still unknown: whether a confirmed call now renders once the inbound AU is no
longer corrupted and the video sender emits SR. The peer will only be proven to
display the browser camera after a new live call.

## Inbound video works live; packetMode 2 is NAL-aligned, not raw-balanced (2026-10-25)

The next live outgoing call validated the receive fixes: 472 authenticated video
packets produced 453 access units, the browser received 453 and decoded 442 with
**zero decoder errors and zero PLIs**, and the remote picture rendered. The three
dumped keyframes decode offline to 240x426 pictures with mean luma 121-130, so
the inbound byte stream was valid.

The same trace still left the Zalo peer black. Outbound was 1,830 packets / 452
access units / 9 keyframes on PT97, ~1.89 MB total, i.e. real encoded video was
flowing. Two native details explain the mismatch:

- `VideoRtpRtcp::setPacketMode` (`0x10028f1dc`) calls
  `ViEReceiver::SetPacketizerMode(7)` **only when packetMode == 1**. Mode 2 does
  not enable the ZRTP balanced splitter; it uses WebRTC's normal H.264
  packetizer. The current negotiation is packetMode 2.
- Inbound packets from the peer under that mode are NAL-aligned: every PT97
  payload began with the Annex-B start code (439/439), so each packet carried a
  complete NAL (or FU-A for oversized NALs). The replacement was splitting whole
  access units into arbitrary equal chunks, where continuation packets do not
  begin with a start code.

`H264RtpPacketizer` now supports `nal-annexb`: every NAL is emitted with a
four-byte start code in one packet, and NALs larger than the MTU use standard
FU-A. `VideoRtpBridge` selects it for packetMode 2 (balanced raw stays for mode
1, `rfc6184` available), and the demo exposes `VIDEO_PACKETIZATION=nal|balanced|
rfc6184`. The receive path also reassembles FU-A fragments inside raw mode.

Live verification of the outbound direction is still required.
