# Call Audio Starter

Browser mic/speaker ⇄ Zalo 1-to-1 voice call. The backend uses **only** the
public API: `zca-js` (QR login), `zca-js/call` (signaling, relay, SRTP, Opus)
and `zca-js/call-webrtc` (browser ⇄ server WebRTC audio). No native binary,
no build step. Video and group calls are ignored (they keep ringing on your
phone). API reference: [`docs/call-api.md`](../../docs/call-api.md).

## Run

```sh
cd ../.. && bun install && bun run build   # build zca-js dist/
cd examples/call-audio-starter
npm install
npm start                                  # http://127.0.0.1:4320
```

1. **Liên kết Zalo (QR)**, scan with the Zalo app.
2. Outgoing: pick a friend → **Gọi thoại** (browser asks for the mic).
3. Incoming: **Nghe (mic trình duyệt)** or **Từ chối**.
4. Live counters (packets sent/received/lost, mic/speaker RMS, peer mute) are
   shown under the call; the event log prints `call.diagnostics()` on end.

`CALL_DEBUG=1 npm start` logs debug lines, including raw answer status codes
and control names needed to confirm the provisional `busy` /
`answered-elsewhere` mappings. `ICE_SERVERS='[{"urls":"stun:…"}]'` and
`ALLOWED_ORIGINS` configure WebRTC/remote access.

## Files

```text
backend.mjs   QR login, createCallController, createWebRtcBridge, action handlers
server.mjs    POST /api/call {action,data}, GET /api/status, WS /ws (events only)
web/          index.html + app.js (vanilla JS)
test/         wiring test with a fake Zalo client
```

Actions: `zalo.login`, `zalo.logout`, `friends.list`, `media.negotiate`,
`media.close`, `call.dial`, `call.answer`, `call.reject`, `call.hangup`, `call.mute`.

## Security

Local demo only: same-origin check, no app-user auth. Credentials, session keys
and relay addresses stay in the backend; the library never logs them.

The previous engine-in-example implementation was moved to
`../call-audio-starter-legacy/` for reference.
