# Independent call research demo

The default backend **does not use or start ZaloCall**, its IPC, its Mac UI,
virtual devices or process taps. Historical native trial files remain in this
directory for reference; they are not the current backend.

**Real Zalo voice calling is not yet verified end to end.** The independent media
leg now bridges browser WebRTC PCM through Opus, RTP/SRTP and the persistent
relay socket, then routes authenticated decoded PCM back to browser speakers.
The answer control remains disabled until the exact ZRTC capability and SRTCP
requirements are supported. A successful relay registration or browser echo is
not a successful Zalo call.

From the repository root:

```sh
npm run build:esm
cd examples/call-web-demo
npm ci
npm run build
npm start
```

Open http://localhost:4317. It binds only to127.0.0.1. Node22/24 and the native
open-source `@roamhq/wrtc` addon are required; Zalo Desktop and Mac audio drivers
are not required for the new backend. Build now compiles only the React UI.

Tone/echo modes test actual WebRTC PCM. Microphone/volume/mute/stop controls
operate in the browser. Tests use fake microphone audio, not your physical mic.
`npm start` enables explicit GC for native WebRTC-wrapper teardown on this host.

For account signaling, use the optional QR login or run
`npm start -- --credential-stdin` and enter operator-provided JSON in the hidden
terminal input. Credentials are retained only in session memory, never files,
URLs, command-line arguments or browser messages.

After QR login, **Gọi đi · thử nghiệm audio** can load up to 200 friends. Choose
a friend and click **Chuẩn bị gọi đi (tự kết nối caller relay)** to send
`/api/voicecall/requestcall` and register a caller relay from its response. This
preflight alone does not ring the friend. Click **Gọi bạn (gửi /request)**; the
button selects Zalo mode, requests microphone permission, starts browser WebRTC
audio, then sends the separate `/api/voicecall/request` offer. These outgoing signaling
steps are wired in the demo, but peer acceptance, answer negotiation and a
two-way live call have not been verified. The UI keeps audio transmission gated
until it receives a successful answer and ACK.

Zalo PC 26.10.20.3253 parses each preflight server using `rtpaddr`, `rtcpaddr`
and optional integer `relayTime` (default zero). Service metadata named `sent`
or `recv` is not required by that native parser and is ignored here. A live
trial reached status zero with six candidates and registered the first caller
relay; this verifies preflight plus relay registration only, not ringing or a
connected call. See the
[outgoing call flow and live checkpoint](../../docs/reverse-engineering/zalo-call-connection-flow.vi.md#live-checkpoint-preflight-và-caller-relay--2026-10-22).

A fresh incoming request is parsed by the independent adapter. The button
“Kết nối relay độc lập” registers one literal UDP endpoint from that offer and
keeps the connected socket alive with the recovered six-second keepalive. To
prepare the browser leg, select Zalo mode and start audio after relay and RTP
SRTP report ready; the browser then requests microphone permission and makes a
WebRTC offer to the local backend. Microphone packets stay gated until call
confirmation. Answer is available only as an explicit experimental trial for
the observed profile1/clear-RTCP offer; the peer-accepted `extendData` schema
is not yet established. Tokens/session/key data are never sent to the UI. RTP frames that pass SRTP authentication are decoded
and routed to browser playback; SRTCP, jitter buffering and a live call have not
been verified.

After relay registration, the incoming-call card can run an explicit answer
trial once browser audio is prepared. It sends status-0 signaling with a
conservative capability candidate for the observed profile1/clear-RTCP relay
offer. HTTP acceptance is not treated as call confirmation: microphone RTP
stays gated until a matching peer `answer_ack` arrives. The candidate has not
yet been accepted in a live call, so this path remains experimental.

When a fresh incoming request arrives, the session log includes a sanitized
offer snapshot: codec payload/frame-time fields, RTP/RTCP address family and
ports, and allowlisted capability values. It omits account IDs, the session ID,
addresses themselves, crypto keys, tokens, and unknown capability fields. This
snapshot helps compare a real incoming offer with the unsupported negotiation
gates without exposing authentication material.

```sh
npm test
node test/browser-controls.mjs
node test/browser.mjs
```

See [independent engine checkpoint](../../docs/reverse-engineering/independent-call-engine.md)
for native evidence, tested primitives, limitations and next implementation steps.
