# `@zca-js/call-react`

Browser client and React hook for the ZCA call gateway. The package owns the
WebSocket RPC/state machine, microphone capture, WebRTC negotiation and speaker
playback (and, experimentally, camera/WebCodecs video). Zalo credentials, relay
tokens and SRTP keys stay inside the Node gateway — never in the browser.

With one call the application gets a working audio call:

```js
await call.call(friendId); // mic + WebRTC + playback are prepared automatically
```

## Install

```sh
npm install /absolute/path/to/zca-js/packages/call-react
# or, inside this repo:
npm install ../../packages/call-react
```

React is a peer dependency (`>=18`) and is not bundled.

A Node gateway must be running (`examples/call-web-demo`: `npm start`, default
`http://127.0.0.1:4317`). The React app should proxy `/ws` and `/api` to it so
the browser sees a same-origin service. For Vite:

```js
// vite.config.js
export default {
    server: {
        proxy: {
            "/ws": { target: "ws://127.0.0.1:4317", ws: true, changeOrigin: true, rewriteWsOrigin: true },
            "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
        },
    },
};
```

In production, serve the app and gateway behind the same HTTPS origin. If the
reverse proxy keeps the public WebSocket `Origin`, start the gateway with
`CALL_ALLOWED_ORIGINS=https://calls.example.com` (comma-separated exact origins).

## React quick start

```jsx
import { useZaloCall } from "@zca-js/call-react/react";

export function CallButton({ friendId }) {
    const { connected, online, state, call, answer, hangup } = useZaloCall();

    if (state.call === "incoming") return <button onClick={answer}>Nghe</button>;
    if (state.call !== "idle") return <button onClick={hangup}>Kết thúc</button>;
    return (
        <button disabled={!connected || !online} onClick={() => call(friendId)}>
            Gọi
        </button>
    );
}
```

A copy-pasteable widget lives in [`examples/minimal.jsx`](examples/minimal.jsx).

That is the entire integration: the hook connects the gateway, requests the
microphone only when needed, negotiates WebRTC, sends the invite and routes the
remote audio to the speakers. No `<audio>` element, no manual RPC sequencing.

The `state.zalo` field reflects the server-owned Zalo session. In production,
authenticate the `ZaloSession` on the Node gateway; do not send credentials or
cookies through this browser library. Incoming calls set
`state.call === "incoming"`; `answer()` accepts.

## Framework-independent usage

```js
import { createZaloCall } from "@zca-js/call-react";

const call = createZaloCall();          // same-origin /ws by default
call.onState((state) => render(state));

// The Node gateway must already have an authenticated Zalo session.
await call.call(friendId);              // audio call, speakers connected
await call.hangup();
```

`createZaloCall` connects on demand, so `call()` / `answer()` never need an
explicit `connect()`. Zalo authentication and session ownership belong to the
Node gateway, not this browser package. This call client intentionally has no
`login()` method.

The local demo has a separate account-linking UI in
`examples/call-web-demo/web/session-controls.js`; it sends an admin command to
the Node gateway to start its QR flow. That helper is deliberately not exported
from this package. Production apps should authenticate/manage the Zalo session
through their server and expose only the needed online state (and, if needed, a
short-lived QR image) to the frontend.

## API

`useZaloCall(options?)` returns:

| Field | Meaning |
| --- | --- |
| `state` | `{ gateway, zalo, call, direction, media, incoming, independent, qr, error, … }` |
| `call(id, { callType })` | Outgoing call (`1` audio, `3` video). Auto-connects and opens media. |
| `callAudio(id)` | Shortcut for `call(id, { callType: 1 })`. |
| `answer()` / `hangup()` | Accept the incoming call / end the active call. |
| `setMuted(bool)` / `setMicrophoneMuted(bool)` | Local microphone mute. |
| `setPlaybackMuted(bool)` / `setVolume(0..1)` | Speaker control. |
| `connected`, `online`, `inCall` | Convenience booleans derived from `state`. |
| `client` | Escape hatch to `ZaloCallClient` (events, diagnostics, video). |

`ZaloCallClient` and `createZaloCallClient` are exported for non-React code.
`onEvent(listener)` exposes sanitized gateway events for diagnostics.

## Source layout

```
src/
  constants.js   initial state, defaults, terminal actions
  urls.js        gateway/config URL resolution
  store.js       observable state + event channel
  transport.js   WebSocket, RPC correlation, reconnection
  media.js       microphone, WebRTC, GainNode playback, mute/volume
  video.js       camera capture (WebCodecs H.264) + remote decoding
  client.js      orchestration and the call state machine
  index.js       public exports + createZaloCall façade
react.js         useZaloCall / useCall hooks
```

The implementation details of the gateway protocol (relay registration, SRTP,
codec negotiation) stay in the server and in `src/call/` of the repository; this
package only speaks the browser-safe RPC surface.

## Notes and limits

- Microphone/camera APIs require a secure context (`https://` or `localhost`).
- Audio is played through a Web Audio `GainNode`; browsers may require a user
  gesture before the `AudioContext` starts, which the call button provides.
- Video is experimental: the gateway negotiates and relays H.264, but Zalo
  interoperability for the outgoing direction is still being verified.
- The package never stores credentials, QR images or media tokens.
