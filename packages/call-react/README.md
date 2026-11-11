# `@zca-js/call-react`

Credential-free browser call client and React hook. The library manages call UI state, browser microphone/WebRTC media, and delegates all signaling to an application-provided `CallTransport`. It does not implement account login and must never receive Zalo credentials, cookies, QR-login secrets, relay secrets, or SRTP keys.

## Architecture

```text
React UI → CallClient / useCall → CallTransport (provided by your app)
                                     ↕ request + events
                             your application backend
                                     ↕
                        account / Zalo / signaling / relay
```

The app owns authentication and constructs a transport that authenticates to its own backend using the app's normal session. Keep Zalo credentials and account sessions server-side. The optional `GatewayTransport` is a compatibility adapter for this repository's demo gateway; it is not required by the generic transport API.

## Minimal custom transport

```js
import { createZaloCall } from "@zca-js/call-react";

const handlers = new Set();
const transport = {
  async request(action, payload) {
    // Send to YOUR backend, using your app's existing auth mechanism.
    const response = await fetch("/api/calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    if (!response.ok) throw new Error("Call request failed");
    return response.json();
  },
  subscribe(handler) {
    handlers.add(handler);
    // Connect your authenticated event channel here, and call handlers with
    // normalized events, e.g. { type: "call-incoming", callId, peerId }.
    return () => handlers.delete(handler);
  },
};

const call = createZaloCall({ transport });
call.onState((state) => renderCallState(state));
await call.call("peer-id");
await call.hangup();
```

`CallTransport` contract:

```ts
interface CallTransport {
  request(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  subscribe(handler: (event: { type: string; [key: string]: unknown }) => void): () => void;
}
```

The app adapter receives neutral actions (`call.prepare`, `call.start`, `call.prepare-media`, `call.accept`, `call.end`, and `media.negotiate`) and maps them to its own backend protocol. It maps backend events into normalized events such as `call-incoming`, `call-state`, `media-state`, and `call-error`. This mapping is application-owned; no Zalo-specific ID or credential format is required by the library contract.

## React

```jsx
import { useCall } from "@zca-js/call-react/react";

function CallButton({ transport, peerId }) {
  const { state, call, answer, hangup } = useCall({ transport });
  if (state.call === "incoming") return <button onClick={answer}>Answer</button>;
  if (state.call !== "idle") return <button onClick={hangup}>Hang up</button>;
  return <button onClick={() => call(peerId)}>Call</button>;
}
```

Create a stable transport instance outside render (or memoize it), since the hook owns a client for the component lifetime. The hook does not log in, acquire account credentials, or expose a QR-login operation.

## Compatibility gateway transport

For the repository demo only, omitting `transport` uses the legacy WebSocket gateway (`gatewayUrl`, default same-origin `/ws`). Its demo server owns Zalo login/session. New integrations should pass their own `transport`. React apps should not send credentials to this package or store them in local storage.

The built-in WebRTC media negotiation expects the demo gateway's ICE configuration and SDP bridge semantics. A custom backend must implement the neutral media actions or provide a compatible media adapter/backend contract; transport injection alone does not make arbitrary call servers media-compatible. Video remains experimental.

## Package layout

- `src/transport.js`: generic transport contract and optional WebSocket RPC adapter.
- `src/client.js`: call state, action orchestration, media lifecycle.
- `src/media.js`: browser microphone, WebRTC and playback.
- `src/react.js`: React hooks.
- `src/video.js`: experimental video capture/decoding.

## Security

- Never pass Zalo credentials, cookies, QR secrets, relay credentials, or SRTP keys to the browser library.
- Authenticate browser requests to your application backend using your app's session and authorize every peer/call action server-side.
- Do not put secrets in event payloads, errors, diagnostic events, or logs.
