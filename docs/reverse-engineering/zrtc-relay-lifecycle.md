# Relay-only voice lifecycle contract

Static follow-up, 2026-10-21. Target: `/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall`, SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`. Source evidence is the previously retained symbolized ARM64 disassembly `/tmp/zalo-call-analysis/helper-arm64-assembly.txt`; preferred addresses below are before ASLR. No native execution, live relay session, credentials, installed application, signing or permission settings were changed for this investigation. These are static observations, not proof of a connected independent call.

## Corrections that affect an independent implementation

**The type127 envelope is selected for P2P in this voice send path, not ordinary relay voice.** `Peer::onSendAudioRtp` (`0x1001b3d58..0x1001b3d9c`) obtains caller flag, call ID, relay token and `p2pIsRunning()`, then passes the latter as argument4 to `initZRTPPacketAudio` (`0x100157d50`). With argument4 false, the initializer chooses type3 RTP or type5 RTCP and stores the relay token; true chooses127/command6 or7. A relay-only gateway must implement the legacy directional formats below. Treating127 as the preferred relay format, solely because it is newer-looking, is not supported by this value flow.

**Registration subcommand is state-dependent.** The existing probe's default2 represents pre-confirmation registration; it is not the universal value for every call phase. `_sendRequestInitZRTPToServer` (`0x10017b7d0..0x10017b7e8`) chooses1 when controller state5,2 otherwise, outside specialized loopback branches.

## Exact controller states

`setCallState` formats both requested and current state names at `0x10016b104..0x10016b390`. Some labels are immediate integer bytes rather than string references; interpreting the little-endian bytes resolves the enum:

| Value | Native label | Independent meaning |
|---:|---|---|
| 0 | NONE | No call |
| 1 | CALLING | Outgoing setup |
| 2 | INCOMING | Incoming setup |
| 3 | RINGRING | Ringing/early call |
| 4 | CONNECTING | Answer handshaking |
| 5 | CONFIRMED | Confirmed call |
| 6 | DISCONNECT | Teardown |

These are `CallController` states, **not** `ZCallInfo` UI states or wire `callState` values. Do not substitute the numbers across those classes. `setCallState` generally rejects non-increasing transitions (`0x10016b404..0x10016b468`), with a special reset/start case after6. Independent state transitions should come from actual signaling/relay events, not a browser button alone.

`isInitedZRTP()` reads controller+0x124 (`0x10015d1a0`); `isInCall()` reads active flag+0xe8 (`0x10015d214`), which is distinct from confirmed state. `setActive` writes that flag at `0x10015cd88`. A successful relay registration alone must not mark the call CONFIRMED in the UI.

## Direction-specific relay media

Builder: `ZRTPPacket::_buildPacketInternal`, mask0xa0a8 at `0x100158374`; parser: `_parsePacketInternal`, masks0x4090/0x8020 at `0x100158a1c`/`0x100158a38`.

| Direction | Content | Type byte | Header | Payload offset |
|---|---|---:|---|---:|
| Client → relay | Audio RTP/SRTP | 3 | u8 type + u32LE selected relay token | 5 |
| Relay → client | Audio RTP/SRTP | 4 | u8 type only | 1 |
| Either direction | Audio RTCP/SRTCP | 5 | u8 type + u32LE token | 5 |
| Client → relay | Audio FEC | 7 | u8 type + u32LE token | 5 |
| Relay → client | Audio FEC | 7 | u8 type only | 1 |

The FEC asymmetry follows builder/parser masks and named FEC initializer (`0x100157dcc..0x100157e08`). Its payload semantics are still unknown; preserve it as opaque or explicitly disable FEC, rather than feed it to an RTP decoder. RTP header fields inside the body retain network byte order; only the custom token is little-endian.

The native parser allows zero payload (envelope minimum1 byte for4/7,5 bytes for5) and rejects payloads over1400 bytes (`0x100158a44..0x100158a94`). Thus structural RX maxima are1401/1405. An independent inner RTP/RTCP validator should separately require a valid minimum RTP header or RTCP structure and authenticate SRTP before delivering audio. Native parser accepts RX types4/5/7; it does not accept TX RTP3 through that branch. Tests must use directional synthetic fixtures, not encode-then-decode symmetry.

Token verification is absent from this parser: type5 simply loads object+0x18, while4/7 contain no token at all. Endpoint/source association and SRTP authentication are necessary; a token is not packet authentication. Whether the higher-level native receive path compares type5 token remains an explicitly open bounded question.

## Registration, relay selection and socket lifetime

Reuse the exact init11/12 recipe in [zrtc-transport-findings.md](zrtc-transport-findings.md). Outgoing caller uses11; incoming callee uses12. Initial pre-confirmation subcommand2; reinitialization while CONFIRMED uses1. Registration includes numeric native local/partner IDs, call ID and raw sessionId authentication string. No account ID conversion should be guessed.

The response must match a selected server by **source sockaddr plus transport type** (`handleZRTPPacket`, `0x1001778e8..0x100177950`). Status0 stores that server's token at info+0x150 and NAT string at+0x158. Nonzero status records failure. Response field38 does not replace call ID, and the NAT string is not an SRTP key. `setCurrentServer` (`0x100167ad4`, token assignment `0x100167bb8..0x100167bbc`) transfers the selected server token to controller+0x110. Do not select a relay or accept a token from an arbitrary datagram.

Server records distinguish RTP IP/port (offset0/0x18), RTCP IP/port (0x20/0x38), transport type(+0x178;1 means TCP), relay token(+0x150) and result/status(+0x154). Registration retry logic checks token and result separately; a sent request is not a successful registration. Relay candidate selection also uses measured responses and configurable selection delays; the first response is not universally the native policy. The two-sided selection and echo-rating policy remain only partially reconstructed. A minimal implementation can choose one **negotiated, successfully registered UDP relay** as an explicit constrained implementation policy, but must not claim identical native selection behavior or assume the peer accepts an unadvertised choice.

`_handleInitZRTPSuccessful` sets initialized+0x124 to1 at `0x100179990..0x100179994` and schedules ongoing jobs. `Peer::sendPacketToServer` (`0x1001a8f48..0x1001a8fd0`) repeatedly sends through its persistent UDP IO object. The current one-shot probe that closes its socket after acknowledgment cannot serve media/NAT lifetime. Keep the same bound socket(s) for registration, incoming packets, keepalive and media for the entire call. Preserve separate RTP/RTCP routing as negotiated; do not infer RTCP port=RTP+1. Exact native socket multiplexing and TCP framing are not established here.

## Timers and keepalive

`_doInitZRTP` (`0x10016e4b0`) sends immediately, resets retry count, takes a configurable retry limit, then schedules the init timeout callback each1000ms. `_handleInitZRTPTimeout` (`0x10017a458..0x10017a484`) exits if init selection finished, state is not1/2, or already initialized; otherwise increments count and compares the configured limit (`0x10017a548..0x10017a550`). Retry only unresolved selected candidates. Additional candidates/fallback can be admitted at configured retry points; there is no evidence for a single global hardcoded retry count.

After registration success, `0x100179a84..0x100179ae0` builds a repeating **6000ms** timer targeting `_sendRequestZRTPPing` (`0x10017c5c0`). That method exits unless initialized flag is1. In CONFIRMED it sends to current server using current token (`0x10017c5f0..0x10017c6b8`); before CONFIRMED it iterates selected servers with nonzero per-server tokens (`0x10017c6bc..0x10017c7f0`).

Ping wire recipe from `initZRTPPacketRequestPing` (`0x100157b88..0x100157bc0`):

```
u8(1) u8(1)                 # request, version1
u32le(0) u32le(0)
u32le(localUserId) u32le(relayToken)
u16le(2) u8(1)              # command2, subcommand1
u16le(sessionIdByteLength) sessionIdBytes
```

The initializer first writes0x7e01 but **overwrites version to1** at0x100157bbc. Do not blindly use init-registration version126 for ping. This is session-authenticated relay keepalive, distinct from command32 forwarded ping/pong used for peer checks and the echo-based server-rating mechanism.

No exact universally applicable liveness expiry threshold was established in this pass. A production controller still needs received-packet timestamps, bounded retransmission, timeout/error transitions and reconnect behavior. Any provisional timeout values must be labeled implementation policy, not recovered protocol constants.

## First audio send gate

`Peer::onSendAudioRtp` calls `_isCanTransferAudio` at `0x1001b3cd0`; a separate early bandwidth-estimation mode may bypass that check (`0x1001b3cdc..0x1001b3ce4`). Do not enable that experimental path for user microphone media.

`_isCanTransferAudio` (`0x1001a8a0c..0x1001a8a84`) requires call mode and active flag. The ordinary final branch permits state5; an option at Peer+0x358==1 also permits4, and Peer+0x35c==1 permits3..5. Names/application meanings of those two options remain unresolved. Safe independent first speech gate: accepted/confirmed signaling, authenticated negotiated SRTP context, registered selected relay, active sockets and valid negotiated Opus parameters. Supporting early audio requires recovering and honoring the actual negotiated capability; do not transmit microphone audio just because a ringing request arrived.

## Hangup contract

`_sendRequestZRTPEndCall` (`0x10016a880`) sends only for a server with a recorded token or result (+0x150/+0x154). At `0x10016a97c..0x10016a990` it supplies local user ID, call ID, **that server's token**, and false to `initZRTPPacketRequestEndCall` (`0x100157b44`). UDP destination is that server's RTP IP/port (`0x10016a9c4..0x10016aa38`). Wire recipe:

```
u8(1) u8(126)
u32le(0) u32le(0)
u32le(localUserId) u32le(relayToken)
u16le(3) u8(0)
u32le(zaloCallId)
```

DISCONNECT teardown sends end requests to retained registered relays before clearing selected servers (`0x10016c1c8..0x10016c220`), then stops timers/network workers (`0x10016c238..0x10016c304`) and resets controller (`0x10016c398`). Independent cleanup should stop producing mic media immediately, send peer-facing end/cancel signaling appropriate to the call phase, send relay end while sockets/token still exist, cancel timers, close sockets and release browser tracks. The exact interleaving of HTTP signaling completion versus relay-end send across the separate `ZCallInfo` job queue has **not** been fully traced; do not claim a strict HTTP-before-UDP ordering from these functions alone. Do not wait indefinitely for a remote acknowledgment before stopping the local microphone.

## Implementation acceptance checklist

1. Persistent relay transport with source checks, directional media parsing, 1000ms bounded registration retries and6000ms session ping; cancellation prevents late timers reopening sockets.
2. Correct callee12/caller11 and phase subcommand2/1; retain per-relay status/token, select an offered successful endpoint and use it consistently for media/end.
3. Actual signaling state drives accepted/connecting/confirmed; separate these from registration and first authenticated received media.
4. Independent supplied-key SRTP/SRTCP and negotiated Opus gateway; relay TX3/RX4, RTCP5; authenticate before decoding and never use type127 as an assumed relay default.
5. Teardown on browser hangup, remote end, call cancellation, listener loss and relay timeout; no stale media, sockets or mic capture on next call.
6. Offline fixtures prove codecs and state safety only. An authorized real test must separately establish remote speech received in the browser and remote endpoint hearing browser microphone, plus both hangup directions. No such end-to-end claim is established by this document.
