# Independent Zalo call engine: reconstruction checkpoint

2026-10-21. Target Zalo Desktop 26.10.20 arm64; ZaloCall SHA256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.

The requested architecture now excludes ZaloCall entirely. The default demo
server does not import/start the helper, use its IPC, select Mac audio devices,
use a process tap, or automate its UI. Old helper/audio trial files are retained
as research history and are not the call backend. No installed app was modified.

**A live Zalo voice call is not yet verified.** One authorized incoming offer
was parsed and its persistent UDP relay registration succeeded for Opus
48k stereo, SRTP profile1 and clear RTCP. The demo now has a manual, gated
402/status0 answer trial using conservative generated capabilities; no peer
acceptance, answer ACK, remote audio or two-way voice has been observed. It does
not treat relay registration or HTTP answer success as a connected call. No
native fallback is selected.

For the ordered path to actual browser mic/speaker calls, see
[engine-free-call-roadmap.vi.md](engine-free-call-roadmap.vi.md). New static
findings for audio framing, relay lifecycle and capability/SRTCP narrow the
relay-first route but do not establish live interoperability.

## Recovered and implemented

| Component | Implementation | Evidence and verification |
| --- | --- | --- |
| Incoming offer/codec schema | `src/call/negotiation.ts` | Native parseRequest 0x10001c824, codec parser 0x100159598; synthetic fixtures |
| Accepted 402 body builder | `src/call/negotiation.ts` | Uses explicit negotiated codecs, selected relay addresses and generated capabilities; fixture tested, not sent |
| Manual answer trial | `examples/call-audio-starter/backend/independent-call.mjs`, `examples/call-audio-starter/backend/zalo-session.mjs`, `examples/call-audio-starter/server.mjs` | Sends status0 only after user action and prepared browser audio; capability candidate is not peer-validated; RTP TX waits for matching answer_ack |
| Modern media/control/P2P envelopes | `src/call/zrtpPacket.ts` | Builder 0x10015830c, parser 0x1001589e8; exact little-endian header fixtures, malformed/bounds/ownership tests |
| Relay callee/caller registration | `src/call/relayRegistration.ts` | Init path 0x10017b738; exact request fixture, successful/error response fixtures, real UDP localhost exchange |
| SRTP profile/key selection | `src/call/srtpParameters.ts` | Explicit key or first30 raw UTF8 bytes of session, mode equality; static reconstruction tested with synthetic values |
| Authenticated SRTP RTP profile1/2 | `src/call/srtpRtp.ts` | Independent Node crypto; published RFC3711 Appendix B KDF/AES-CM vectors, nonzero IV, authentication, replay and rollover tests |
| Directional relay media envelope | `src/call/relayMediaPacket.ts` | TX type3/RX type4, RTCP5 and opaque FEC7; token checked for RTCP and payload copied |
| Persistent relay registration | `src/call/relayRegistration.ts` | Connected UDP socket, bounded 1s registration retries, 6s keepalive, TX media envelopes and relay end; explicit UI action |
| RTP parser and sender state | `src/call/rtpAudio.ts` | RTP v2 parser including CSRC/extensions/padding; per-call SSRC, sequence and timestamp counters |
| RTCP report and parser | `src/call/rtcp.ts` | Compound SR/RR + SDES/CNAME builder and SR/RR report-block parser; unit tested |
| SRTCP relay path | `examples/call-audio-starter/backend/independent-call.mjs` | Matched local/remote srtcp gates separate send/receive contexts; protect before type5 wrap, unwrap before authenticate/parse; offline relay round-trip tested, no remote interoperability proof |
| Independent Opus codec and browser bridge | `examples/call-audio-starter/backend/opus-gateway.mjs`, `examples/call-audio-starter/backend/media.mjs`, `examples/call-audio-starter/backend/independent-call.mjs` | WASM libopus; WebRTC `RTCAudioSink` mic PCM to relay, authenticated receive decode to `RTCAudioSource`; TX stays gated until confirmation |
| Independent offer observer | `examples/call-audio-starter/backend/independent-call.mjs` | Session/key data remain in memory, sanitized diagnostics, no auto-answer or import-time networking |

`src/index.ts` exposes these primitives under `experimentalCallProtocol`.
No external proprietary code or binary is loaded by them. SRTP is a new,
experimental implementation; standards-vector success is not a Zalo call test.

Protocol here named ZRTP is Zalo's envelope, not RFC6189 ZRTP key agreement.
Normal registration has header type1/version126, userId at10, command11 caller
or12 callee at18, state-dependent subcommand at20, callId21, partnerId25,
u16LE session byte-length29 and session bytes31. IDs are request.uidTo/from and
params.id, not the full account UID. Server response token/NAT bytes remain
private. The old probe closes its UDP socket; the new `ZrtpRelaySession`
retains a separate connected socket for one offered endpoint. Neither path
means the call has been answered.

## Required lifecycle, still incomplete

1. Parse a fresh incoming offer, resolve the relay candidate policy and codec.
2. A persistent connected UDP relay session now registers one literal offered
   endpoint, retains its token/socket, sends 6s keepalives, delivers sanitized
   media metadata and sends relay end during teardown. Candidate ranking,
   multiple endpoints, TCP and live Zalo acceptance remain unimplemented.
3. Complete media setup and capabilities (`extendData`), including supported
   SRTP mode and SRTCP. The type5 SRTCP send/receive path now has offline tests,
   and one live offer confirmed the profile1/clear-RTCP case sufficiently to
   register the relay. Mode3 and native noSeq currently fail as unsupported.
4. A manual status0 answer trial now generates a conservative capability
   candidate from the supported relay-only path and sends it only after browser
   audio preparation. Peer acceptance and exact minimum capabilities remain
   unverified; native retry behavior is not yet mirrored.
5. Require a matching remote answer_ack before declaring confirmed or opening
   RTP TX. HTTP402 success alone does not prove that the peer answered or
   receives audio; the ACK action spelling/data shape still needs live capture.
6. The browser leg now connects WebRTC PCM, Opus and RTP/SRTP to the persistent
   relay; received packets that authenticate and decode enter browser playback.
   Still needed: wire-compatible timestamps/SSRC proven with a real peer, jitter
   buffering, a negotiated RTCP scheduler, receive-statistics feedback and packet pacing under relay jitter.
7. Verify actual bidirectional speech, hangup, cancellation, reconnect, next call.

Native Opus uses payload112 for16kHz and113 forother rates. Codec name AND
payload must match. Browser Opus defaults cannot be forwarded unchanged.
Native SRTP noSeq may zero sequence before encryption and has a patched replay
check; the current standard SRTP implementation deliberately rejects it.
Native mode0 permits an unencrypted path but the replacement does not silently
fall back to plaintext when negotiation is unknown.

## Verification

```sh
npm run build:esm
bun test ./test/zrtpPacket.ts ./test/zrtcNegotiation.ts ./test/zrtcRelay.ts ./test/srtpRtp.ts ./test/voiceCall.ts
cd examples/call-audio-starter
npm run build
npm test
npm run test:media
npm run test:protocol
```

Demo unit/WebRTC suite: 16 tests passed after the manual answer-trial path.
Browser fake-mic mute/unmute/speaker/track cleanup passed. UDP and ICE tests
need localhost network access; Chrome tests need the installed Chrome browser.
Offline tests never call a contact or use physical microphone audio.

One live incoming offer and relay registration were verified without ZaloCall.
No live answer/ACK or remote speech is verified. The port4318 server was an
older incoming-call-only process and showed `zalo: disconnected`, no active
media, and no outgoing state. It has been stopped; port4318 now redirects to
the current outgoing-capable demo on port4317. The 4317 session is online, but
no outgoing request has been sent in this session yet. Only sanitized summaries
should be logged. Do not save cookies, session IDs, keys, raw offers, or decrypted
audio in fixtures/docs.

Detailed native evidence:
[zrtc-negotiation-findings.md](zrtc-negotiation-findings.md),
[zrtc-transport-findings.md](zrtc-transport-findings.md),
[zrtc-srtp-findings.md](zrtc-srtp-findings.md),
[zrtc-relay-lifecycle.md](zrtc-relay-lifecycle.md),
[zrtc-audio-contract.md](zrtc-audio-contract.md), and
[zrtc-capabilities-contract.md](zrtc-capabilities-contract.md).
Primary crypto reference: [RFC3711 Appendix B](https://www.rfc-editor.org/rfc/rfc3711#appendix-B).
