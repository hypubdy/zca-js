# Zalo Desktop call signaling (experimental)

Follow-up native runtime trials and selected implementation direction:
[zalo-call-trials.md](./zalo-call-trials.md).

Analyzed locally: `/Applications/Zalo.app`, version **26.10.20**.
The ASAR SHA-256 and exact source locations are recorded in
`zalo-call-evidence.json`. No application code was executed and no calls were
placed. REA evidence is retained at `/tmp/zalo-call-analysis/rea-evidence.json`.
REA reported integrity mismatches in unpacked native binaries, including
`zcall_mac.node`; their implementation has not been verified.

## Implemented surface

### Incoming-control path comparison

The installed Electron bundle (`znotification` chunk, SHA-256 and source offsets in
`zalo-call-evidence.json`) handles VoIP controls in `handleControl`. It drops
incoming requests when the desktop's notify-call setting is off and drops
controls whose `data.ts` is more than 60 seconds old. Otherwise it sends the
control toward native IPC; `eventFromCtrlPolling` itself is gated by desktop
call support and IPC availability. These are desktop UI/native gates, not proof
that the account server withholds the websocket event from other clients.

The repository listener independently handles chat websocket `version=1,
cmd=601, subCmd=0`, decrypts `data`, walks `controls`, and emits each
`act_type="voip"` control as `call`. That parser has no desktop notify-setting
or 60-second timestamp filter. The demo previously logged only emitted VoIP
actions, so an absent UI event could mean no 601 frame, an empty/non-VoIP batch,
or a decode/shape error. It now emits a bounded `call_control_batch` summary
containing only counts and unique `act_type:act` strings; no call IDs, account
IDs, session strings, or raw payloads are retained. This diagnostic has not yet
been confirmed against a fresh live incoming call.

`api.listener.on("call", event => ...)` exposes `act_type: "voip"`
controls from the existing decrypted control stream (601). The desktop bridge
recognizes `request` / `group_request` as incoming requests and forwards the
whole control to native code. The listener preserves unknown actions and data;
it does not infer that an answer means media has connected. Delivery through
the web client's socket still needs live verification.

`api.voiceCall` implements one-to-one signaling using the session's existing
AES, authenticated request, service discovery and response decoding:

| Method | Endpoint | Observed payload |
| --- | --- | --- |
| `ring(callerId, callId)` | `ringring` | callerId, callId, status=0, imei |
| `answer(payload)` | `answer` | callerId, callId, status, codec, rtcpAddress, rtpAddress, session_id; optional extendData + subCommand=3 |
| `answerAck(calleeId, callId)` | `answerack` | calleeId, callId, status=0, imei |
| `cancel(callerId, callId, callType)` | `cancel` | callerId, callId, callType, status=0, imei |
| `end(uidTo, callId)` | `endcall` | uidTo, callId, status=3, imei |

All are encrypted GET requests under `/api/voicecall/`. These methods only send
signaling; they do not create an audio connection. `answer.status` and
`cancel.callType` deliberately have no guessed enum/default. A compatible media
engine must provide the status and codec/session/transport parameters.

```ts
api.listener.on("call", event => {
    console.log(event.act, event.data);
    // Inspect the actual request schema before extracting callerId and callId.
    // After identifying a one-to-one request:
    // await api.voiceCall.ring(callerId, callId);
    // await api.voiceCall.answer(engineAnswer);
    // await api.voiceCall.end(partnerId, callId);
});
api.listener.start();
```

## Remaining work for full calling

The current desktop bridge sends controls through `$zcall.sendDataToNative`.
Native emits signal 407 (ring), 402 (answer), 408 (ack), 405 (cancel), and 409
(end); JavaScript then sends the HTTP requests above. Native owns the call state
and media negotiation. The older packaged `vcmac.js` wrapper calls
`setConfig`, `setMediaConfig`, `incomingCall`, and `stop` in `zcall_mac.node`.
Those wrappers alone do not establish the current native transport protocol.

Full answering with audio still requires reconstruction of the active native
engine: initialization/authentication, codec negotiation, RTP/RTCP or ZRTP,
device capture/playback, timeout/cleanup, and its IPC framing. The web session's
common parameters and response format may differ from the desktop session;
server compatibility has not been demonstrated. Group calls are not implemented.
No live integration result is claimed by the offline checks.
