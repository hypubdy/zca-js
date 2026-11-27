# Call Starter (voice + video)

Browser mic/speaker/camera ⇄ Zalo 1-to-1 voice or video call. The backend uses
**only** the public API: `zca-js` (QR login), `zca-js/call` (signaling, relay,
SRTP, Opus, H.264 RTP) and `zca-js/call-webrtc` (browser ⇄ server WebRTC
audio). Video is encoded/decoded in the browser with WebCodecs (Chrome/Edge)
and carried as H.264 Annex-B frames over `WS /video`. No native binary, no
build step. Group calls are ignored. API reference:
[`docs/call-api.md`](../../docs/call-api.md).

## Run

```sh
cd ../.. && bun install && bun run build   # build zca-js dist/
cd examples/call-audio-starter
npm install
npm start                                  # http://127.0.0.1:4320
```

1. **Liên kết Zalo (QR)**, scan with the Zalo app.
2. Outgoing: pick a friend → **Gọi thoại** or **Gọi video** (browser asks for mic/camera).
3. Incoming: **Nghe video** (video calls), **Nghe (mic trình duyệt)** or **Từ chối**.
   The **Camera** checkbox toggles your camera (sends `/conf` to the peer).
4. Live counters (packets sent/received/lost, mic/speaker RMS, peer mute) are
   shown under the call; the event log prints `call.diagnostics()` on end.

`CALL_DEBUG=1 npm start` logs debug lines, including raw answer status codes
and control names needed to confirm the provisional `busy` /
`answered-elsewhere` mappings. `ICE_SERVERS='[{"urls":"stun:…"}]'` and
`ALLOWED_ORIGINS` configure WebRTC/remote access.
`VIDEO_PACKETIZATION=balanced|rfc6184` overrides the outgoing H.264
packetization (default `nal` for packetMode 2) if the peer shows a black screen.
`VIDEO_REQUEST_ENABLE=0` stops sending `video.enable` in the outgoing `/request`
(on by default, as native Zalo does) for A/B comparison.

## Files

```text
backend.mjs   QR login, createCallController, createWebRtcBridge, action handlers
server.mjs    POST /api/call {action,data}, GET /api/status, WS /ws (events only)
web/          index.html + app.js (vanilla JS) + video.js (WebCodecs camera/decoder)
test/         wiring test with a fake Zalo client
```

Actions: `zalo.login`, `zalo.logout`, `friends.list`, `media.negotiate`,
`media.close`, `call.dial` (`{peerId, video}`), `call.answer`, `call.reject`, `call.hangup`,
`call.mute`, `call.camera` (`{enabled}`).

## Security

Local demo only: same-origin check, no app-user auth. Credentials, session keys
and relay addresses stay in the backend; the library never logs them.

The previous engine-in-example implementation was moved to
`../call-audio-starter-legacy/` for reference.
