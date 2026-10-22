# Independent Zalo audio media contract

Static investigation, 2026-10-21. Target: installed universal `ZaloCall`, SHA-256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.
Addresses below are unslid arm64 virtual addresses from the retained
`/tmp/zalo-call-analysis/helper-arm64-assembly.txt`. This pass did not run the
engine or contact Zalo servers. It establishes code paths, not live negotiation
or successful speech. Read with `zrtc-negotiation-findings.md` and
`zrtc-srtp-findings.md`; their transport/security prerequisites still apply.

## New findings and their implementation consequences

| Property | Static evidence | Consequence / qualification |
| --- | --- | --- |
| Outgoing audio SSRC | `Peer::_initAudioRtpRtcp`, `0x10019ac80–0x10019ac90`, calls controller `getUserId()` then `AudioRtpRtcp::setSSRC(int)` | Use the local **call/relay user ID** from incoming-call preparation, preserving its int32 bit pattern; do not copy the browser SSRC or assume the account's long UID is this value. |
| SSRC storage/delegation | `AudioRtpRtcp::setSSRC`, `0x100272f14–0x100272f48`, stores at `+0xc8` after RTP module setter | The SSRC has both RTP and local bookkeeping significance. |
| Initial sequence number | `RTPSender::SetSSRC`, `0x1003f1b6c–0x1003f1b84`: if sequence is not explicitly set, calls `Random::Rand(1, 0x7fff)` and stores a uint16 | Native default is randomized 1–32767 when changing/initializing SSRC. Explicit overrides elsewhere remain possible. An independent context must retain sequence and ROC across the whole call. |
| Send codec | `Peer::_initAudioRtpRtcp`, `0x10019acdc–0x10019acfc`, gets actual `AudioDevice::codec()` then `registerSendPayloadOnly` | Negotiated codec determines payload, rate, channels; do not hardcode every call to PT112. |
| Receive codec list | `AudioDevice::receiveCodec`, `0x10024e6dc–0x10024e704` and `0x10024e7ac–0x10024e7d4` | Native supports PT112 `opus`, 16000 Hz, and PT113 `opus`, 48000 Hz. Previous decoder constructor trace establishes mono16k and stereo48k. This is support, not proof of a particular live choice. |
| Encoder RTP clock | `AudioEncoderOpusImpl::RtpTimestampRateHz`, `0x10036d468`, returns configuration `+0xc`, same as `SampleRateHz` at `0x10036d458` | The 16k native variant exposes a 16k clock to its RTP sender. Browser Opus timestamps cannot simply be copied. End-to-end selected timestamp path still requires live validation. |
| Negotiated dynamic frame time | `AudioCodecItem::parseJson` (`0x10015e3b4–0x10015e3f0`) accepts `dynamicFptime` only as integer1; merge in `CallController::negotiateCodec` (`0x100161f54–0x100161f94`) leaves it off unless both codec items enable it, selects60 only when both values are60, otherwise uses the selected valid `frmPtime` | Preserve the flag separately from nominal `frmPtime`. This reconstructs the observed merge branch, not the complete behavior of every call path. |
| Runtime frame-time updates | `AudioEncoderOpusImpl::ApplyAudioNetworkAdaptor`, `0x10036dc2c–0x10036dc84`, may apply `SetFrameLength`; `Peer::adjustFptime` validates then calls `AudioDevice::setEncodeFrameLength` (`0x1001a964c` onward) | The active packet duration can change after codec negotiation. The channel setter must succeed before AudioDevice updates its stored value (`0x1002475fc–0x100247670`). |
| Frame-time packetization | `Num10MsFramesInNextPacket`/`Num10msFramesPerPacket`, `0x10036d470`/`0x10036d4f8`, use frame length divided by10 with a remainder check; `Utility::isFrameTimeValid` (`0x100156234–0x10015625c`) accepts positive multiples of20 through120 | Packet assembly is based on 10ms PCM blocks, while the validator accepts20,40,60,80,100,120ms. Follow the active accepted frame length rather than baking in20ms. This set is derived from optimized static arithmetic, not a live negotiated offer. |
| Packet PCM accumulation | `EncodeImpl`, `0x10036e35c–0x10036e400` and `0x10036e410–0x10036e4dc` | Accumulates `(frame_ms / 10) * (sample_rate / 100) * channels` int16 samples. Both divisions have remainder checks; insufficient input returns an empty EncodedInfo. |
| Actual codec call | `EncodeImpl`, `0x10036e5c8–0x10036e628` | Calls `WebRtcOpus_Encode` with buffered sample count **per channel**, not byte length or interleaved total. |
| Encoded timestamp | `EncodeImpl`, `0x10036e338–0x10036e348` and `0x10036e74c–0x10036e754` | Saves the timestamp supplied with the first block in a packet and returns it as EncodedInfo timestamp. It does not take the timestamp of the final accumulated block. |
| DTX initial setting | `AudioDevice::_setChannelCodec`, `0x1002473b8–0x1002473c0` | Explicitly calls `Channel::SetOpusDtx(false)` after setting codec. This path disables Opus DTX; later reconfiguration is not excluded. |
| VAD initial setting | Same function `0x1002473a4–0x1002473b4` | Calls `SetVADStatus(false, 0, true)`. Do not treat absence of microphone speech as permission to stop the RTP clock or relay maintenance. |
| Codec FEC initial setting | Same function `0x10024737c–0x100247384` | Calls `SetCodecFECStatus` with configured bool at AudioDevice `+0xb5e1`; this pass does **not** establish that bool's default. |
| Loss / NACK initial setting | Same function `0x100247388–0x1002473a0` | Calls `SetAudioLossRate(0)` and `SetNACKStatus(configured_bool, 50)`. The configured NACK bool is at AudioDevice `+0xf6cc`; do not label NACK unconditionally enabled. |
| Later FEC changes | `AudioDevice::enableFec`, `0x10024db6c–0x10024dbac` | Updates `+0xb5e1` and applies to all channels. A fixed FEC guess is not a complete call implementation. |
| Frame length can change | `AudioDevice::setEncodeFrameLength`, `0x1002475fc–0x100247648` | Forwards to `Channel::SetFrameLength` and stores only on success. Honor negotiated frame time and later supported changes. |

For a selected 16000 Hz mono 20 ms codec, the accumulation formula gives **320
samples / 640 PCM16 bytes per packet**, built from two 160-sample 10 ms blocks.
The corresponding candidate native timestamp increment is **320**, whereas the
browser leg normally operates with its independently negotiated Opus RTP clock.
These are calculated consequences of a *selected 20 ms/16k/mono configuration*,
not a claim that every call uses it. The negotiation report establishes 20 ms
as a fallback; the actual offer must still be checked. Initial RTP timestamp
offset and all extension semantics are not fully established by this pass.

Frame duration is not safely modeled as a constant. Codec negotiation selects
and validates a nominal `frmPtime`, then combines `dynamicFptime` only if both
matched codec entries enable it; the observed special value60 is selected only
when both entries request60. Runtime Audio Network Adaptor output can later
call the Opus encoder's frame-length setter. The source proves these update
paths exist, but does not prove they are enabled on every call. A browser gateway should keep the current active
duration in call state and update PCM accumulation, packet pacing, and RTP
timestamp progression together when a validated change arrives.

## RTP is wrapped, not just a naked Opus datagram

`Peer::onSendAudioRtp` (`0x1001b3c4c`) receives a full RTP packet from the RTP
module, allocates a ZRTPPacket, obtains caller flag, call ID, relay token and P2P
status (`0x1001b3d58–0x1001b3d84`), and invokes:

```text
initZRTPPacketAudio(isCaller, callId, token, p2pIsRunning, false)
packet.mediaLength = rtpLength                 // object +0x664
memcpy(packet.mediaBytes, rtp, rtpLength)       // object +0xeb
sendMediaPacket(packet, chosenP2pIp, chosenP2pPort)
```

Evidence: `0x1001b3d88–0x1001b3dd8`. The final false marks the ordinary audio
branch here. `initZRTPPacketAudio` is at `0x100157d50`:

- P2P false: ordinary packet type3; alternate final bool gives type5; relay token
  is stored at object `+0x18` (`0x100157d8c–0x100157da0`).
- P2P true: packet type127, subtype6 (or7 for alternate bool), version9,
  direction byte `!isCaller`, call ID at `+0x38`, zero field `+0x10`
  (`0x100157d50–0x100157d84`).

These are **in-memory offsets**, not wire offsets. Use the separately recovered
ZRTP serializer and encryption boundary; do not send this C++ object layout or
apply SRTP to the outer envelope by accident. This custom ZRTP naming does not
mean RFC6189 key agreement. Existing relay-only packet support does not imply
P2P initialization has been implemented.

## Receive path and audio delivery

### Call-state gates recovered from the ARM64 peer

The key media transition is `Peer::setCallState`, not the HTTP answer result.
When the peer advances to state5 (`CONFIRMED`), it invokes
`Peer::_handleStartCall` (`0x1001a773c`). That function creates the active
SRTP transports from the controller's key/mode, resets audio RTP state, applies
the negotiated audio codec and bitrate, then calls `_handleStartAudio`
(`0x10019c3a8`). `_handleStartAudio` is idempotent; it calls `Peer::startAudio`
and reports device errors. `startAudio` opens recording and playout through
`AudioDevice::startRecord` and `startPlayout`. Thus a matching answer ACK must
advance the peer to confirmed, and successful audio-device startup is a separate
local prerequisite for live speech.

`Peer::_handleRingring` (`0x1001a5bc0`) resets RTP state and optionally starts
the early-call bandwidth estimator when `gccEarlyCall` is enabled. It does not
open the audio device. Early media is additionally gated: `Peer::onReceiveAudioPacket`
(`0x1001b4308`) forwards a packet only when `_isCanTransferAudio()` succeeds or
the controller's `isAllowRecvAudioFromRingring()` is true. `_isCanTransferAudio`
(`0x1001a8a0c`) requires call mode and an active controller. Normally it allows
state5 only; peer option `+0x358 == 1` allows states4/5, and option
`+0x35c == 1` allows states3/4/5. The meanings and negotiation source of those
two peer options are unresolved. Do not enable speculative pre-confirmation
media in the independent client.

For incoming relay media, the observed order is:

1. The relay packet parser produces the directional type4 audio RTP, type5
   audio RTCP, or type7 FEC object. The persistent relay session must already
   be registered and retain the selected source/endpoint and token.
2. `_processReceiveZRtcPacket` (`0x1001bcc90`) selects an SRTP transport via
   `Peer::getSRTP`, unprotects the inner media bytes, then dispatches type4 to
   `AudioRtpRtcp::receiveAudioPacket` and type5 to
   `AudioRtpRtcp::receiveAudioRtcpPacket`. An authentication/unprotect failure
   drops the packet before RTP parsing. Type5 uses SRTCP only when negotiated;
   type4 always takes the audio SRTP transport when one exists.
3. The RTP receiver parses RTP, tracks SSRC/CSRC and sequence/loss state, then
   forwards decoded payload plus its RTP header to `Peer::onReceiveAudioData`
   (`0x1001b413c`). The peer checks that playout is active before passing the
   payload to `AudioDevice::receiveAudioData` (`0x10024e054`).
4. `AudioDevice` maps the remote SSRC to a WebRTC channel and inserts the packet
   into its receive channel. The Opus decoder produces PCM; the channel's
   playout callback ultimately supplies that PCM to the selected browser/server
   audio sink. A valid relay packet, successful SRTP authentication, or even
   successful Opus decode alone does not prove the user can hear speech.

For transmit, `Peer::_handleStartCall` configures the negotiated Opus encoder;
`startAudio` starts mic capture and playout; encoded RTP then reaches
`Peer::onSendAudioRtp` (`0x1001b3c4c`). That callback checks the ordinary media
gate (`_isCanTransferAudio`), applies SRTP to the RTP body, wraps it in the
directional relay envelope and sends it on the registered relay session. The
independent demo follows the same safety order conceptually: prepare browser
audio and codec/crypto/relay state before answer; wait for matching answer ACK
before mic RTP; authenticate/decode incoming RTP before browser playback.

This is static binary evidence. It does not establish that the current demo's
answer capabilities are accepted by a peer, that an answer ACK arrives, or
that either direction has passed real speech. The engine-free demo still needs
one authorized two-endpoint trial with sanitized counters at each boundary:
relay packet received, SRTP authenticated, RTP parsed, Opus decoded, PCM played;
and mic PCM captured, Opus encoded, SRTP protected, relay packet sent, remote
peer confirmed.

`AudioRtpRtcp::receiveAudioPacket` (`0x1002735d4`) passes object media bytes
`+0xeb` and signed media length `+0x664` to its RTP header parser at
`0x100273628–0x100273640`. It derives stream identity from SSRC or a nonzero
CSRC (`0x10027364c–0x100273654`), updates packet/loss/order state, and passes
payload through the audio RTP receiver. `OnReceivedPayloadData`
(`0x1002744d0`) forwards payload and parsed WebRtcRTPHeader to its registered
callback.

`Peer::onReceiveAudioData` (`0x1001b413c`) checks nonempty data/header, reads
remote SSRC at header `+8`, creates/updates the peer audio channel when needed
(`0x1001b4198–0x1001b41d0`), tracks SSRC/CSRC, and calls
`AudioDevice::receiveAudioData(remoteSsrc, header, payload, length)` at
`0x1001b4264–0x1001b4278` when playout is active. AudioDevice maps peer to
channel and forwards to its channel receiver (`0x10024e10c–0x10024e174`).
The linked Opus decoder handles packet FEC detection and redundant decode
(`AudioDecoderOpusImpl::ParsePayload`, `0x10036a5d8`; redundant decode
`0x10036aa14`). The exact calls
`WebRtcOpus_DecodeFec` at `0x10036aa70` and `WebRtcOpus_Decode` at
`0x10036aaa8` are confirmed. A received UDP packet or successful SRTP unprotect
is not equivalent to decoded/played speech.

## Minimal independent browser bridge, in dependency order

1. Terminate browser WebRTC on the independent server. Keep browser
   DTLS/SRTP/ICE state separate from Zalo relay SRTP/token state.
2. Complete incoming-call negotiation and relay registration before reporting
   accepted. Retain local call ID, peer ID, token, selected codec/frame time,
   SRTP profile/key/flags and chosen RTP/RTCP endpoints in one call session.
3. On TX, obtain PCM from browser audio, downmix/resample to selected codec,
   accumulate exactly one packet duration, encode using independently supplied
   Opus, and generate RTP with local call user ID as SSRC, negotiated payload,
   one sequence per sent packet and negotiated/native clock progression.
   Preserve first-block timestamp and pace sends; do not emit a burst of queued
   audio. Initial sequence default above is recovered; initial timestamp and
   negotiated extensions remain to validate.
4. Protect the RTP bytes using the negotiated SRTP profile and native flag
   behavior, then apply the recovered ZRTP envelope and send to the registered
   relay. Keep relay token/direction fields outside the Opus encoder.
5. On RX, validate envelope/length/session/source, extract protected media,
   authenticate and unprotect with persistent replay/ROC state, parse RTP
   including CSRC/extensions/padding, select decoder by payload, reorder within
   a bounded jitter buffer and decode Opus with loss concealment/FEC policy.
   Resample decoded PCM to the browser audio source rate and deliver paced
   blocks to browser WebRTC.
6. Implement SRTCP/RTCP reports, NACK/retransmit behavior that the negotiated
   mode needs, relay keepalive/retry and bilateral end/cancel cleanup. Keep
   these active even during silent mic input.
7. Validate RX and TX independently on an authorized call: authenticated packet
   counters, decoded PCM energy, browser receive audio, remote confirmation of
   browser mic audio, hangup in each direction, then a second call with fresh
   contexts. Unit vectors and synthetic tones alone cannot satisfy this gate.

PCM transcoding is the recommended first bridge because it isolates browser
Opus negotiation from the native 16k clock/payload/channel differences and makes
received audio measurable. Packet-only forwarding is an optimization after
codec/timestamp/extension compatibility is demonstrated; it is not the current
proven path.

## Remaining questions, with next bounded evidence targets

- Initial RTP timestamp/offset: follow `RTPSender::SetStartTimestamp`
  (`0x1003f18c4`), RTP module constructor
  and its explicit setters. No timestamp zero/default assertion is justified yet.
- Exact selected codec configuration reaching Opus constructor: follow
  `Channel::SetSendCodec` (`0x1003194b4`) into encoder configuration,
  then corroborate offer and an authorized engine-free packet trace.
- FEC/NACK defaults and dynamic changes: follow AudioSetting construction and
  AudioDevice initialization assignments to the fields in the table above.
- RTP extension5 registration is visible in `AudioRtpRtcp::_create` at
  `0x1002729a0–0x1002729d0` when congestion controller exists. The virtual
  registration calls pass `(5,5)`; numeric enums alone do not establish the
  full wire semantics or mandatory status. Resolve mapping and peer modes.
- Transport unprotect ordering, profile3/noSeq compatibility and SRTCP remain
  governed by the security/relay reports. They are blockers, not optional
  polish, for modes that negotiate them.

Coverage: focused arm64 functions listed here; not a complete binary analysis.
No live call, codec setting, remote audibility, or browser-only interoperability
was observed by this static pass.
