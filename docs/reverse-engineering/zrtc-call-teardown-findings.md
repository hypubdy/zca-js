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
