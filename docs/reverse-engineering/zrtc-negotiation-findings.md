# ZRTC one-to-one negotiation reconstruction

Evidence date: 2026-10-21. Static arm64 disassembly only; no target execution or network performed by this investigation. Target `/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall`, universal SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`. Addresses below are unslid virtual addresses in `/tmp/zalo-call-analysis/helper-arm64-assembly.txt`. These are local assembly evidence references, not REA retained IDs. Provider decompiler unavailable; conclusions follow named functions and instruction/data flow, not strings alone.

## Incoming request schema (answered statically)

`ZMessageDeserializer::_parseActRequest` at `0x10001c824` allocates a zero-initialized `ZIncomingCallInfo` of size `0x150`. It reads these fields from its JSON object argument:

| Field | Parser | Destination offset |
| --- | --- | --- |
| status | JSON signed int | 0x10 |
| uidFrom | int or decimal string -> signed int32 | 0x14 |
| uidTo | int or decimal string -> signed int32 | 0x18 |
| ts | int64 or decimal string -> signed int64 | 0x20 |
| uidN | string | 0x40 |
| params | string, parsed as JSON | temporary |

The function's separate string argument is copied to offset `0x28`. Its interpretation belongs to the caller; this function does not read an outer `callId` or `type`. Do not invent either as a requirement of this parser.

`params` must decode successfully; otherwise it takes failure/cleanup path at `0x10001c990`. From the decoded value it reads:

| Field | Type | Destination offset |
| --- | --- | --- |
| platform | int | 0 |
| protocol | int | 4 |
| id | int | 0x0c |
| sessId | string | 0x88 |
| extendData | string | 0xa0 |
| rtpIP | string | 0xb8 |
| rtcpIP | string | 0xd0 |
| avatar | string | 0x100 |
| Dname | string | 0x118 |
| codec | string | 0x130 |
| zrtc_config | JSON value serialized using toString | 0x70 |
| servers | JSON value serialized using toString | 0xe8 |

Evidence range `0x10001c994–0x10001cb40`. Helpers ignore many individual parse return values, leaving zero/empty defaults: absence of a field is not proven to cause rejection. `parseJsonIntValue` at `0x1000f2830` uses `isInt/asInt`; `parseJsonStringValue` at `0x1000f2ab4` uses `isString/asString`; mixed int parser at `0x1000f2b78` uses `stoi(...,10)` for strings. The int64 variant uses `stoll(...,10)` at `0x1000f2d0c`.

`_parseActRequestDetail` at `0x10001dfa0` reads `params.fec.enable` int into offset8, `params.video.enable == 1` into boolean0x14b, serializes `params.settings` into string0x58 and reads `settings.logDebug == 1` into boolean0x14a. It parses the already-stored `extendData` string as JSON and reads `callType == 1` into boolean0x14c. Non-objects leave defaults.

## Field meaning established by consumers

`ZCallInfo::_prepareCallConfig` at `0x1000cd588` copies uidTo to CallConfig offset0, uidFrom to offset4, current callId to offset8, sessId to offset0x10, protocol to offset0x28, fec.enable to offset0x30. It copies codec and extendData to MediaCodecInfo beginning at ZCallInfo0x730, and rtpIP/rtcpIP to fields0x7b8/0x7d0. Thus `id` and session are separate identifiers; do not substitute outer ids indiscriminately.

`ZCallInfo::_processAcceptCallJob` at `0x1000c2f0c` only proceeds from native state10, changes it to13, and calls `PeerWrapper::incomingCall` with config, callback, MediaCodecInfo, rtpIP, rtcpIP and a third stored string. `Peer::incomingCall` at `0x1001a61...` parses RTP and RTCP address strings through `ZRTPServerInfo::parseRtpAddress/parseRtcpAddress` with delimiter `':'` at `0x1001a62b8/0x1001a62d4`, negotiates codec at `0x1001a6644`, creates network/device workers and enters call state. Accepting therefore requires transport/session preparation; simply sending answer402 does not implement this behavior.

`parseRtpAddress` at `0x1001bda20` searches backward for the last separator, rejects separator at index<1 or last character, copies preceding bytes as host and parses suffix. This is a host:port string, not an array or SDP. Address validity beyond this boundary is not fully reconstructed.

In Zalo PC 26.10.20.3253 (x86_64 native SHA-256 `94ab8fa4afef21574933d6f5feb9e47fbf4da75f3b9ef1239ae587f1c1377990`), `CallController::parseJsonServer` at `0x1e2c10` requires its decoded JSON to be an array. Each object reads `rtpaddr` and `rtcpaddr` with `CallUtility::jsonGetString`, parses both with colon separator, and reads optional integer `relayTime` with `CallUtility::jsonGetInt(..., 0)`. It does not read service fields named `sent` or `recv` in this function. The prior `sent`/`recv` claim came from a different artifact/address interpretation and must not be used as the current parser contract. This is a different schema from top-level request rtpIP/rtcpIP; preserve both.

## Audio codec JSON (answered statically)

Codec string decodes to an array of objects. `AudioCodecItem::getJson` at `0x100159438` serializes exactly:

```json
[{"name":"opus/16000/1","payload":112,"frmPtime":20,"dynamicFptime":0}]
```

The example combines evidenced field names and native default codec; frame-time20 is the fallback, not an observed remote advertisement. `AudioCodecItem::parseJson` at `0x1001595ac` reads name string and payload/frmPtime/dynamicFptime integers default0. `CallController::reset` assigns native support item name `opus/16000/1` and payload112 at `0x10015ac78–0x10015ac8c`; this does not prove all calls select this item or that browser SDP Opus is directly compatible.

`CallController::negotiateCodec` at `0x1001618cc` parses both local and remote codec JSON arrays, parses object items via AudioCodecItem, matches exact name bytes AND payload number (`0x100161e3c–0x100161e58`, `0x100161ea4–0x100161ec0`). Frame-time validity uses `Utility::isFrameTimeValid`; invalid frame time falls back20ms (`0x100161f40–0x100161f4c`). Matching only `opus` or changing payload number to browser111 would not mirror this function.

The dynamic-frame merge is now partly reconstructed from `0x100161f54–0x100161f94`: `AudioCodecItem::parseJson` stores `dynamicFptime` as true only when its integer JSON value equals1 (`0x10015e3b4–0x10015e3f0`). For a matched codec, the negotiated dynamic value stays0 unless both local and remote values are nonzero. If both are nonzero, it is60 only when both values equal60; otherwise it is the already-selected valid `frmPtime` (or the 20ms fallback). This is a narrow native merge rule, not evidence that every Zalo call selects dynamic frame time. Related merge copies occur at `0x1001620cc–0x100162114` and `0x10016642c–0x100166474`; their caller-specific semantics were not independently reconstructed. The dynamic flag should therefore be preserved through negotiation and represented separately from nominal `frmPtime`.

Frame time is also mutable after negotiation. `AudioEncoderOpusImpl::ApplyAudioNetworkAdaptor` (`0x10036dc2c–0x10036dc84`) conditionally applies runtime frame-length updates; `Peer::adjustFptime` (`0x1001a964c` onward) validates a requested value and forwards it to `AudioDevice::setEncodeFrameLength`; the device stores the new value only if channel `SetFrameLength` succeeds (`0x1002475fc–0x100247670`). `Num10MsFramesInNextPacket`/`Num10msFramesPerPacket` divide frame length by10 and check the remainder (`0x10036d470`, `0x10036d4f8`). A replacement must pace and packetize from the active frame length, not assume the initial 20ms fallback remains fixed. This does not establish the precise set of values accepted by `Utility::isFrameTimeValid` or that runtime adaptation is enabled on every call.

Correction from further inspection: the validator's optimized arithmetic is now decoded. `Utility::isFrameTimeValid` at `0x100156234–0x10015625c` uses multiply-by-`0xCCCCCCCD`, rotate-right2, then a bound check against `0x79` (121). Evaluating the unsigned multiply/rotate predicate shows accepted positive frame times are exactly **20, 40, 60, 80, 100, and 120 ms**; zero, nonmultiples of20, and values above120 fail. This agrees with packetization's 10ms block unit but is stricter than merely “multiple of10”. The valid set is a static interpretation of the optimized predicate, not evidence that every accepted duration is offered or used live.

## Answer envelope (answered statically)

`ZMessageSerializer::sendAnswerCall` at `0x100026324` produces:

```js
{
  type: "sendSignal", command: 402,
  data: {
    callerId: string, callId: int, status: int,
    codec: string, extendData: string,
    rtpAddress: string, rtcpAddress: string, session: string
  }
}
```

Evidence fields `0x100026378–0x1000264c4`; command0x192 at `0x100026510`. Values must be supplied from the initialized session; this serializer does not establish which status value means successful answer, or when it is valid to send it. Keep JSON-in-string codec/extendData/session fields as strings.

## SRTP key and mode (substantially answered statically)

`ZRtcConfig::fromJson(Json::Value)` reads `srtpKey` string into config offset0x440 (`0x1001f0434–0x1001f0440`), `srtpMode` int into0x45c (`0x1001f04c8`), and `srtpRTCP` bool into0x460 (`0x1001f0510`). Do not log these secret values.

`CallController::parseCallConfig` at `0x10015dba0` copies that config into controller0x1060, then:

1. Uses mode only if `rtc::SupportSrtpCrypto(mode)` accepts it; otherwise0 (`0x10015dbe0–0x10015dbfc`).
2. Copies explicit config.srtpKey to controller key0x4a8 (`0x10015dc00–0x10015dc10`).
3. If supported mode is nonzero and key is empty, takes the first `min(sessionId byte length, GetSrtpCryptoLengths(mode))` bytes of stored sessionId0xf8 as the key (`0x10015dc54–0x10015dcac`, long-string copy `0x10015ed84–0x10015eddc`). No base64 decode or hash is in this fallback path.
4. `SupportSrtpCrypto` at `0x10029a2d0` accepts exactly1,2,3; `GetSrtpCryptoLengths` at `0x10029a2a8` returns30 for1,2,3 and0 otherwise. A session shorter than30 is not padded here; downstream key setup may fail.
5. Attempts actual SRTP setup via callback (`0x10015dcd4`), clears mode/RTCP/P2P flags on failure, caches initial successful mode at0x4c4 (`0x10015dd04`).

`Peer::createAndInitSRTP` at `0x1001a1d14` requires nonempty key and mode>=1. It duplicates the same key string for both send and receive, and configures separate RTP/RTCP SrtpTransport instances with those copies (`0x1001a1e18–0x1001a1e40`). `SrtpTransport::SetUpKey` at `0x100299e74` passes string bytes/lengths into `SetRtpParams` (`0x100299f04–0x100299f4c`). `cricket::SrtpSession::DoSetKey` at `0x100299250` maps mode1 to `srtp_crypto_policy_set_rtp_default` for both RTP and RTCP, mode2 to `aes_cm_128_hmac_sha1_32` for RTP and rtp_default for RTCP, mode3 to `aes_cm_128_null_auth` for both (`0x100299298–0x1002992e8`). Key length must equal key+salt lengths exactly (`0x10029930c–0x100299318`).

`CallController::_parseExtendData` at `0x100162bb...` parses peer's JSON string. Remote `srtpMode` (default0) must equal cached initial local mode or effective mode becomes0 (`0x1001630d8–0x100163138`). Remote `srtcp` integer compared with cached local flag; mismatch disables RTCP encryption (`0x100163154–0x1001631b8`). It similarly reads `sP2P` afterward. Unsupported effective mode clears SRTP via callback (`0x100163250–0x100163280`). These are protocol negotiation rules; a replacement must negotiate them instead of assuming browser DTLS-SRTP.

## Native relay initialization entry (partially answered)

`CallController::_sendRequestInitZRTPToServer` at `0x10017b738` constructs `ZRTPPacket::initZRTPPacketRequestInitCall` at `0x10017ba70`. UserId controller0xec, partnerId0xf0 and callId0xf4 load into its three integer arguments (`0x10017b980–0x10017b984`). Strings include session-like supplied argument and additional metadata; exact argument producer mapping remains pending.

Packet initializer at `0x100157978` sets internal header word0x7e01, request subtype11 for caller /12 for callee, stores local user ID, partner/call identifiers, session string and flags. These are INTERNAL OBJECT offsets, not network wire offsets; use serialize function evidence before implementing a packet writer.

## Replacement feasibility and remaining work

Independent signaling parse, audio codec schema, address parse, answer envelope, and SRTP key fallback can now be implemented without loading ZaloCall. None establishes a successful engine-free call yet. Browser WebRTC requires a gateway: native relay initialization/custom packets and Zalo media transport do not expose a standard SDP/ICE/DTLS offer in these paths.

Still required for interoperable media: complete relay wire serializer/parser and handshake response/token; exact packet wrapping/encryption boundary; libsrtp suite mapping and flags; Opus frame timing/clock/SSRC/sequence rules; RTCP/keepalive/retry/teardown; engine-free authorized inbound runtime validation. Preserve these as unresolved, and do not enable a UI state claiming the remote party hears audio just because HTTP402 succeeds.

## Accepted inbound lifecycle follow-up (2026-10-21)

The identifiers are now tied all the way to relay initialization:

| Source | CallConfig | CallController | Relay initializer argument |
| --- | --- | --- | --- |
| outer uidTo | uint32-shaped offset0 | userId at0xec | integer1 |
| outer uidFrom | uint32-shaped offset4 | partnerId at0xf0 | integer2 |
| params.id | atomic ZCallInfo callId -> config8 | zaloCallId at0xf4 | integer3 |
| params.sessId | config0x10 | sessionId at0xf8 | session string |
| outer uidN | partner ZCallUserInfo0x8 | not substituted into relay integers | answer.callerId through getNoisedUserId |

Evidence: `_updateCallInfo` `0x1000cd3f0–0x1000cd40c` sets callId and stored answer session; `0x1000cd474–0x1000cd494` copies uidN and numeric uidFrom to partner info. `_prepareCallConfig` `0x1000cd5c4–0x1000cd5e8` swaps incoming uidFrom/uidTo into partner/local slots. `Peer::_initCallConfig` `0x1001a5110–0x1001a5164` calls setUserId/setPartnerId/setZaloCallId/setSessionId. `_sendRequestInitZRTPToServer` `0x10017b980–0x10017b984` loads controller integers0xec,0xf0,0xf4 into packet constructor arguments. Full account uid from login is not used for these relay IDs in this trace. Preserve signed parser int32 bits when writing unsigned network values.

Incoming ringing (`receiveIncomingCall`) sets ZCallInfo state10 at `0x1000cd0d4`, updates info/UI, sends ring command through sendRingRingCall (`0x1000cd210`), then prepares config (`0x1000cd244`). It does not call Peer.incomingCall yet.

User accept: `UiAnswerCallEvent(true, ...)` at `0x1000c8b78` requires state10 (`0x1000c8bd0`), checks media permission and queues `_processAcceptCallJob` (`0x1000c8c18–0x1000c8c90`). The job changes state10 to13 and invokes Peer.incomingCall (`0x1000c2f20–0x1000c300c`). User decline follows status3 answer at `0x1000c8e6c`; do not confuse that with accepted status0.

Peer.incomingCall at `0x1001a61c8` requires nonnull config+codec and not already in call, parses initial relay RTP/RTCP host:port, sets caller=false in `_initCallConfig`, adds the parsed server with addServer(server,true) at `0x1001a655c`, negotiates codec and calls `_initZrtcConfig`. It enters CallController state2 at `0x1001a6748`; independent socket creation/registration is required before answer.

Relay registration success is the prerequisite for native accepted402: `_handleInitZRTPSuccessful` selects successful server (`0x100179618` setCurrentServer), establishes maintenance timers, and at `0x100179cec` checks caller flag. Caller branch supplies selected RTP/RTCP to callback slot0x58 (=ZCallInfo.onInitZrtpWithServer). Callee branch `0x100179d38–0x100179d64` invokes callback slot0x30 (=ZCallInfo.onIncomingCall).

This callback identity was corroborated by read-only raw arm64 vtable bytes: `ZCallInfo` vtable base `0x100cbbaa8`, address-point+0x10, full-table entry0x40 is `0x1000c63b4` (onIncomingCall), entry0x68 is `0x1000c6960` (onInitZrtpWithServer). Thus vptr slots0x30 and0x58 are exact, not inferred from log labels.

`onIncomingCall` `0x1000c63b4` sets ZCallInfo state13 then schedules `_trySendAcceptSignal` with period3000 (`0x1000c6414–0x1000c6438`), and sets Peer state4 (`0x1000c646c`). `ZScheduleThread::processFunc` at `0x1000c3a60` invokes the stored function immediately (`0x1000c3a88`) before waiting each period and repeating (`0x1000c3ad4`). Therefore the first accepted answer is immediate after registration success, with repeats every3seconds while state13, not a mandatory initial3second delay.

`_trySendAcceptSignal` at `0x1000c2c9c` only proceeds when state13, marks acceptedSent flag0x88b and emits call event12 (`0x1000c2cc8–0x1000c2cd4`), then builds accepted402 with status0 (`0x1000c2d78`):

```js
{
  callerId: originalRequest.uidN,
  callId: originalParams.id,
  status: 0,
  codec: JSON.stringify(negotiatedActiveAudioCodecs),
  extendData: JSON.stringify(generatedNegotiatedCapabilities),
  rtpAddress: currentSelectedRelayRtpAddress,
  rtcpAddress: currentSelectedRelayRtcpAddress,
  session: originalParams.sessId
}
```

`buildZrtcAcceptedAnswer` in `src/call/negotiation.ts` now serializes this body
from explicit negotiated codecs, selected relay addresses and a caller-generated
capability object. It does not infer the minimum accepted `extendData`, send the
signal, or mark the call confirmed; the demo does not call it yet.

The native getters show answer addresses refer to the selected relay (`CallController::getCurrentRtpServer/getCurrentRtcpServer` `0x1001686fc/0x10016870c`), not local UDP socket address. If initially supplied server succeeds it can be that server; alternate candidate selection can change it. Do not blindly echo the first offer address after selecting a different relay.

`getExtendData` at `0x10016871c` builds a JSON object containing `p2p` when enabled, nested `video.codec`, `callType`, `newZrtc`, local platform, packetMode, gccMode, effective srtpMode, sP2P, srtcp, gccAudio, gccSVLR, tpType, spTcp, gccEarlyCall and more conditional flags. Source values are local/effective engine config, not a verbatim echo of caller extendData. Field reads are demonstrated at `0x100168884–0x100168aac`; a standalone implementation should advertise only supported paths, and must not claim arbitrary packetMode or cryptography support. Exact minimal accepted capability object remains to be validated with authorized inbound traffic.

The receive-answer acknowledgment path below establishes the transition to confirmed state. Static teardown findings and the browser demo's HTTP + relay hangup behavior are recorded in [zrtc-call-teardown-findings.md](./zrtc-call-teardown-findings.md). Neither analysis proves a live engine-free call.

### Response versus remote acknowledgment

`receiveAnswerResponse` at `0x1000cc318` (successful HTTP402 response callback) requires state13, completes the accepted-signal scheduler promise (`0x1000cc380`) and emits peer call event13 (`0x1000cc38c`). It does not set connected state. `receiveAnswerAck` at `0x1000cc3e0` validates non-null data, same callId, state13 and nonduplicate ACK; completes scheduler promise (`0x1000cc52c`), emits event13, sets ACK flag0x889, then calls Peer.setCallState(5) (`0x1000cc54c`). `_onNativeChangeState2Confirmed` at `0x1000c80dc` sets outer ZCallInfo state1 and updates UI. A replacement must distinguish HTTP answer accepted from remote-call confirmation.

Scheduler retry details are established by `ZScheduleThread::processFunc` `0x1000c3a60`: callback invokes immediately, subsequent wait deadline is now+period milliseconds, timeout invokes callback again. Thus retries should stop on successful HTTP402 response OR remote answerAck, and cleanup must cancel them.

## Individual video request/answer signaling (Ghidra confirmation 2026-10-22)

The previously unresolved one-to-one serializers are now identified:

- `ZMessageSerializer::sendZRtpRequestCall` at `0x10002605c` emits `type:"sendSignal"`, `command:0x1a0` (416), with `data` containing exactly `calleeId`, `callId`, `rtpAddress`, `rtcpAddress`, `codec`, `extendData`, and `session`.
- `ZMessageSerializer::sendAnswerCall` at `0x100026324` emits `type:"sendSignal"`, `command:0x192` (402), with `data` containing exactly `callerId`, `callId`, `status`, `codec`, `extendData`, `rtpAddress`, `rtcpAddress`, and `session`.
- `ZMessageSerializer::sendAnswerAckCall` at `0x100026628` emits `type:"sendSignal"`, `command:0x198` (408), with `data` containing `calleeId` and `callId`.
- `_parseActAnswer` at `0x10001c394` reads envelope `callId` and `status`, then parses JSON string `params` and extracts `codec`, `extendData`, and `platform`.
- `_parseActAnswerAck` at `0x10001ceb8` parses the acknowledgement object and dispatches it without any codec fields.

This confirms that video does not use a separate one-to-one signaling command. The distinction is carried in `callType` and the nested `video.codec` capability in the JSON string `extendData`; the outer 416/402/408 envelopes are shared with audio. It still does not prove that a guessed video `status`, codec string, or answer capability is accepted by the server.

## Outgoing call-type value (Ghidra confirmation 2026-10-22)

`ZCallInfo::_updateCallInfo(std::shared_ptr<ZMakeCallInfo>)` at `0x1000cd938`
copies `ZMakeCallInfo.type` directly into the outgoing call's type field at
`ZCallInfo+0x890`; `_trySendRequestCallSignal` passes that byte to
`sendRequestCall`. The incoming path at `0x1000cd3b4` maps `callType == 1` to
native type `3` and audio to native type `1`. Therefore the outgoing preflight
uses `typeRequest: 1` for audio and `typeRequest: 3` for video. The demo backend
now accepts `callType: 3`, advertises the observed H.264 capability, and keeps
that value through caller relay registration and command 416 construction.
This prepares signaling only; it does not yet provide browser video frames or
prove that the remote peer accepts the video media answer.

The native `sendAnswerCall` serializer spells the session field exactly `session`.
The REST adapter retains its historical `session_id` field and now also supplies the
native spelling when sending an answer, so video and audio answer paths preserve both
compatibility forms until a live server response confirms which one is required.
