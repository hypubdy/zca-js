# Zalo one-to-one call teardown findings

Static ARM64 disassembly review of ZaloCall 26.10.20, 2026-10-21. These findings describe the desktop call controller; they do not prove an engine-free live call.

## Recovered native sequence

`ZCallInfo::receiveRequestEndCall` (`0x1000c10ac`) enqueues `EndcallAction` value1 when the call state is nonzero and not state2. `_processEndcall` (`0x1000c10fc`) unregisters the device notifier, appends the action and two integer arguments to a queue, and schedules `_processEndCallJob` (`0x1000c1e8c`). The enum names and meanings of the two integer arguments are not recovered here.

`_processEndCallJob` consumes one queue item, ignores duplicate work when the outer state is already0 or2, changes the outer state to2, stops four worker flags, gathers end-call logging data, and calls `PeerWrapper::endCall` (`0x1000b78e4`). It then sends the end-call log, calls `ZCallInfo::reset` (`0x1000bf478`), which resets the peer call state to0 and clears call/session/media flags. The method does not expose a direct promise to browser code. `PeerWrapper::endCall` enqueues work on the peer's job queue with a 6000ms delay; this is native worker scheduling evidence, not a safe delay for an independent client to copy.

Relay teardown is a separate controller operation: `_sendRequestZRTPEndCall` (`0x10016a880`) sends command3 to each registered relay while its socket and token remain available. See [zrtc-relay-lifecycle.md](./zrtc-relay-lifecycle.md) for the packet fields and ordering limits.

The JavaScript/native signaling bridge maps native signal409 to the encrypted HTTP endpoint `/api/voicecall/endcall` with `{ uidTo: toId, callId, status: 3, imei }`. The repository's `api.voiceCall.end(uidTo, callId)` implements this request. It is distinct from relay command3: HTTP endcall informs Zalo's call signaling service, while relay command3 closes a registered media-relay session.

## Browser demo behavior

The web demo's hangup action stops the browser WebRTC tracks first, starts HTTP endcall for the active incoming offer when the Zalo session remains online, and immediately sends relay command3 while disposing relay, codec, SRTP and audio state. It does not wait for the HTTP request before closing the local relay. If the account has disconnected, it still stops local audio and closes the relay; it reports that no HTTP signal was sent. Remote cancel/endcall events clear pending call state and close the local relay.

The demo must not show the remote call as confirmed merely because the end HTTP request succeeded. Confirmation still depends on the matching answer acknowledgment, and this teardown path does not establish working bidirectional voice.

## Decline must carry the full /answer body (2026-11-28)

Bug report (from an app using the package, account ids redacted): after
`call.reject()` the caller's phone kept ringing until the caller cancelled. Two
live attempts: Zalo answered the decline with "Tham số bị thiếu hoặc không
đúng" (missing/invalid parameters). Causes:

1. `sendTeardown("decline")` sent `voicecall/answer` with only
   `{callerId, callId, status: 3, session_id}`: no `rtpAddress`/`rtcpAddress`,
   empty `codec`, no `extendData`. The accepted answer (status 0), which Zalo
   takes, carries all of them.
2. `finish()` swallowed the teardown error, so `reject()` resolved as if it had
   worked. `hangup()` on a ringing incoming call used the same path.

Native reference, ZaloCall 26.11.10: `ZCallInfo::UiAnswerCallEvent`
(`0x1000c8b78`) declines through the same `ZMessageTransfer::sendAnswerCall`
as accepting, status 3, with `PeerWrapper::getActiveAudioCodecs()`,
`getExtendData()`, `getCurrentRtpServer()`, `getCurrentRtcpServer()` and the
session; `UiCloseEvent` (`0x1000c9270`) and the busy branch of
`receiveIncomingCall` (`0x1000ccbbc`) do the same.

Fix in `voiceCall.ts`:

- decline = the accepted-answer body built from the offer (selected Opus codec,
  local capabilities, the offer's relay as RTP/RTCP, session) with status 3; no
  relay is opened. Unplannable offers still send codec/addresses/session raw.
- if `/answer` is refused, send `endcall` so the caller stops ringing;
- `finish()` resolves to the teardown error and `reject()`/`hangup()` throw it
  (`CallError` code `zalo-rejected`); the call still ends locally.

Tests: `controller.test.mjs` checks the decline fields and the endcall fallback
/ error surfacing. **Not yet verified live**: whether Zalo needs exactly these
fields (the offer's relay as "current server" is the closest pre-answer
equivalent). Live check: reject from the library while a phone rings it; the
phone must stop ringing within ~1 s and the log must show no "decline answer
failed". For a byte-exact reference, capture Zalo Desktop pressing "Từ chối".
