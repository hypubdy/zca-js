# Independent ZRTC transport reconstruction

Static ARM64 investigation, 2026-10-21. Target: installed `ZaloCall`, SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`. Evidence source: `/tmp/zalo-call-analysis/helper-arm64-assembly.txt`, generated from this artifact. Addresses below are preferred Mach-O virtual addresses, before ASLR. REA native provider unavailable in this session; observations are manually followed symbolized disassembly, not decompiler or runtime results.

These findings support an independent packet codec. They do **not** establish an independently connected Zalo call, successful SRTP authentication, or received speech. Local browser WebRTC cannot directly speak this transport merely by changing SDP.

## Evidence index

| Function | Preferred address | Assembly start line |
|---|---:|---:|
| `ZRTPPacket::_buildPacketInternal` | `0x10015830c` | 345713 |
| `ZRTPPacket::_parsePacketInternal` | `0x1001589e8` | 346155 |
| 16-bit length-prefixed writer | `0x100158810` | 346039 |
| 32-bit length-prefixed writer | `0x1001588e4` | 346091 |
| 16-bit length-prefixed reader | `0x100158ed8` | 346467 |
| 32-bit length-prefixed reader | `0x100158f90` | 346515 |
| `ZRTPPacket::toString` | `0x100159048` | 346564 |
| `Peer::createAndInitSRTP` | `0x1001a1d14` | 421601 |
| `SrtpTransport::SetUpKey` | `0x100299e74` | 677910 |
| `rtc::SrtpCryptoSuiteFromName` | `0x10029a140` | 678093 |
| `rtc::GetSrtpKeyAndSaltLengths` | `0x10029a280` | 678174 |

Line numbers are navigation conveniences for the retained temporary assembly. Addresses/function names are the stable anchors for this build.

## Serialization conventions

All custom header integer fields below are **little-endian**: the ARM64 builder uses unmodified `str/stur/strh` stores and parser uses corresponding loads, without `rev`. This applies to the custom envelope, **not** to embedded RTP fields, which retain their RTP network byte order.

Do not confuse in-memory object offsets with packet offsets. The object contains a vtable and strings; it cannot be copied onto the wire. Neutral field names below deliberately preserve unknown meanings. `object+0x18` is positively identified as `token` by `toString` at `0x100159078` (`MsgType, cmd, subCmd, token, data size`). Other names such as call ID need upstream argument/value-flow confirmation.

The parser copies at most `0x578` (1400) bytes into its embedded media payload buffer. An independent implementation should reject malformed/truncated lengths strictly, even where original control handlers discard a nested reader's return value.

## Modern envelope: message type 127

Both builder and parser agree on this header:

| Packet offset | Width | Value/source |
|---:|---:|---|
| 0 | 1 | `0x7f` |
| 1 | 1 | version / object `+0x09` |
| 2 | 1 | role flag / object `+0x668` |
| 3 | 4 | little-endian field38 / object `+0x38` |
| 7 | 2 | little-endian command / object `+0x1c` |

For commands **6 through 10 inclusive**, the remaining bytes starting at offset **9** are media. Command identity is established by the named initializers: 6 audio RTP, 7 audio RTCP, 8 video RTP, 9 video RTCP, 10 audio FEC. The audio initializer `0x100157d50` sets command 6/7 based on its last bool argument, header size 9, type127, role flag equal to logical NOT of its first bool argument. No version or role value check is visible in the packet parser. Empty media body is accepted by the native parser; normal media needs a meaningful RTP/FEC body.

For commands outside 6..10, the extended header adds offset9=u8 subcommand and offset10=u32LE field10; body starts14. `initP2PRequestBinding` (`0x100157e68`) uses command1 with a one-byte binding value at14. Response/ACK binding commands2/3 add that byte at14 then a u32LE length-prefixed string from15. Echo command4 has subtype-dependent body and an apparent TX/RX branch asymmetry; do not implement its interpretation based on the initializer name alone. Command5 is P2P signal and has the 14-byte extended header.

## Legacy media envelopes: directional differences

Builder mask `0xa0a8` at `0x100158374` selects types **3,5,7,13,15**: offset0 type, offset1 u32LE token, body offset5. Named initializers assign audio RTP3, audio RTCP5, audio FEC7, video RTP13, video RTCP15.

Parser mask `0x4090` at `0x100158a1c` selects types **4,7,14** with *only* a type byte and body offset1. Parser mask `0x8020` at `0x100158a38` selects **5,15**, retaining the u32LE token and body offset5. This is a real directional distinction; a symmetric legacy encode/decode model would be incorrect. Prefer modern127 for the first independent codec until controller-mode negotiation is understood.

## Control envelope: type1 request / type2 response

| Offset | Width | Meaning/source |
|---:|---:|---|
| 0 | 1 | message type1 request or2 response |
| 1 | 1 | version / object+9 |
| 2 | 4 | u32LE field0c |
| 6 | 4 | u32LE field10 |
| 10 | 4 | u32LE field14 |
| 14 | 4 | u32LE token |
| 18 | 2 | u16LE command |
| 20 | 1 | subcommand |
| 21 | rest | command-specific body |

Builder supports request type1; parser accepts both1 and2. It does not validate the version byte. The request builder allows commands2,3,5,11,12,14,32,33,51 via its bitmask. A reusable independent generic header codec should preserve opaque body bytes rather than invent semantics for unsupported commands.

Confirmed request bodies:

- Command2 ping and14 change-address: u16LE byte length + string bytes at21 (`0x100158690`).
- Command3 end-call: u32LE field38 at21 (`0x1001586d8`).
- Commands11/12 init: if `(subcommand & 6) != 0`, offset21=u32LE object+e4,25=u8 object+e8,26=u8 object+e9,27=u8 object+ea; u16LE length-prefixed authentication string begins28. Otherwise offset21=u32LE field38,25=u32LE field3c; length-prefixed authentication string begins29. The newer initializer sets object+e9=5 and subcommand4; the earlier initializer uses command11 when its first bool is true and12 otherwise. Optional u16LE length-prefixed object+48 string follows authentication string when nonempty.
- Command32 forwards selected subcommands with u32LE length-prefixed strings; others use u16LE lengths. Preserve opaque body until subcommand mapping is completed.

Confirmed response behavior for command11/12: offset21=u32LE status; nonzero returns success from packet parsing without parsing further. On status0, offset25=u32LE field38,29=u32LE token,33=u16LE length + string bytes into object+48. See `0x100158db8..0x100158e1c`. Native code discards the last string reader's result here; an independent parser should reject truncation instead.

## SRTP: supplied key rather than automatic browser DTLS

`Peer::createAndInitSRTP` rejects empty key or mode<1, copies the provided `std::string` key twice unchanged, creates two `SrtpTransport` instances, and passes both copies to `SetUpKey`. `SetUpKey` selects send/receive key order based on the constructor's role, but the two keys in this Peer path are equal. It delegates to Cricket `SrtpSession::SetSend/SetRecv`. There is no DTLS exporter or key derivation in this inspected path. This does not rule out other initialization paths elsewhere.

Supported suite mapping is statically exact:

| Mode | Name | Master key | Master salt |
|---:|---|---:|---:|
| 1 | AES_CM_128_HMAC_SHA1_80 | 16 bytes | 14 bytes |
| 2 | AES_CM_128_HMAC_SHA1_32 | 16 bytes | 14 bytes |
| 3 | CS_AES_CM_128_NULL_AUTH | 16 bytes | 14 bytes |

`GetSrtpCryptoLengths` returns30 for modes1..3; `SupportSrtpCrypto` accepts exactly1..3. A constructor boolean stored at SrtpTransport+0x2c causes SetUpKey to force mode3; its application-level meaning remains unresolved. Do not assume the authentication mode from a string alone.

Configuration parser at `0x1001f0430` reads JSON `srtpKey` string into config+0x440, `srtpNoSeq` integer into+0x458, `srtpMode` integer into+0x45c, `srtpRTCP` bool into+0x460, and `sP2P` bool into+0x461. This is a static configuration input, not proof these values occur in the actual inbound signaling. The controller's extend-data parser also reads compact `srtcp` and `sP2P` controls, validates mode through `SupportSrtpCrypto`, and disables unsupported SRTP. Further upstream tracing must establish whether `srtpKey` is base64-decoded, generated, or supplied by signaling before Peer receives it.

Additional direct key-source evidence: `CallController::parseCallConfig` (`0x10015dba0`) copies the parsed config into its config member at+0x1060, then copies configured `srtpKey` (controller+0x14a0 = config+0x440) unchanged into controller+0x4a8 (`0x10015dc04..0x10015dc10`). When this string is empty and the negotiated mode is supported, it falls back to **the first min(sessionId byte length,30) raw bytes of sessionId**, without a hash or base64 conversion in this path (`0x10015dc2c..0x10015dcac`, long-string branch `0x10015edd4`). Object+0xf8 is positively identified as sessionId by getter `0x10015d068` and setter `0x10015d090`. A sessionId shorter than30 yields a shorter candidate key, which the subsequent SRTP initializer may reject; do not silently pad it. This is an observed legacy fallback, not permission to choose or weaken a negotiated key. The sessionId's upstream source and whether the active deployment uses this fallback remain unknown.

`PeerCallZRTPImpl::_handleStartCall` at `0x1001a7738` obtains controller key/mode and calls the create-SRTP virtual method at `0x1001a781c` with the final bool argument false. This confirms the force-null-auth boolean is false in that start-call path; it is not a reason to select mode3.

## Remaining blockers and next experiments

1. Recover controller construction and full init request field identity: user ID, call ID, relay token, auth string, peer capabilities, retries/timeouts. Codec correctness alone cannot register a relay session.
2. Trace actual inbound answer signaling response to relay host/port and key delivery without logging credential/token/key values. Preserve only schemas/field types and synthetic fixtures.
3. Recover key conversion and `srtpNoSeq` behavior before selecting a maintained SRTP library. No cryptographic downgrade or hardcoded secret should be introduced.
4. Build an offline independent packet codec and malformed-length tests from these static layouts. Label generated fixtures synthetic; they are not captured wire compatibility tests.
5. Use a user-authorized test call with separate reference and independent runs to compare transport state transitions; do not run both as the same registered endpoint concurrently. Observe relay acknowledgment before reporting connected. Verify remote speech RX and TX separately.
6. Implement Opus/RTP packetization, jitter buffer, RTCP, loss/replay handling, and browser WebRTC gateway with independent maintained libraries. The browser-facing DTLS-SRTP session and the Zalo-facing supplied-key session are distinct.

No installed app, code signing, permission database, credentials, or live network session was modified by this investigation.

## Registration value-flow follow-up

Further static tracing resolves several neutral fields without live packet capture:

| Controller field | Confirmed getter/setter | Packet destination for ordinary init11/12 |
|---|---|---|
| +0xec userId | `getUserId` 0x10015d0b8 / `setUserId` 0x10015d0c0 | object+0x14, wire+10 |
| +0xf0 partnerId | `getPartnerId` 0x10015cf80 / `setPartnerId` 0x10015cf88 | object+0x3c, wire+25 |
| +0xf4 zaloCallId | `getZaloCallId` 0x10015d130 | object+0x38, wire+21 |
| +0xf8 sessionId | `getSessionId` 0x10015d068 | u16LE length + raw bytes at wire+29 |
| +0x110 token | `getToken` 0x10015d0a8 / `setToken` 0x10015d0b0 | assigned after relay response |
| +0xe9 caller bool | `setCaller` path | true=>command11, false=>command12 |

The mapping follows `_sendRequestInitZRTPToServer` (`0x10017b738`): `0x10017b980` loads userId/partnerId and `0x10017b984` callId; `0x10017ba60..0x10017ba70` passes them to the already decoded packet initializer. `_sendRequestInitZRTPAllSelectedServer` (`0x1001654cc`) explicitly copies controller sessionId and passes it as authentication string (`0x1001655ac..0x1001655f4`), with empty optional suffix. A custom caller may use another supplied string in the generic method; the ordinary selected-server flow uses sessionId.

Packet constructor `0x1001578c0` zeros field0c/field10/token and fields38/3c. The ordinary init initializer overwrites version to **126** via `strh 0x7e01` (type1 byte then version126), userId, callId, partnerId and subcommand; it leaves field0c/field10/token zero. The sender path `CallController::_sendPacketToServer` (`0x10016a338`) delegates without modifying the packet. `Peer::sendPacketToServer` (`0x1001a90c0`) serializes it directly into its local buffer and submits to UDP IO; it likewise does not modify those header fields.

Thus the ordinary non-loopback init byte recipe is:

```
01 7e
u32le(0) u32le(0) u32le(localUserId) u32le(0)
u16le(isCaller ? 11 : 12)
u8(subcommand)
u32le(zaloCallId) u32le(partnerId)
u16le(sessionIdByteLength) sessionIdBytes
```

Subcommand is normally2 when controller state !=5 and1 when state==5 (`0x10017b7d0..0x10017b7e8`); an additional specialized loopback branch influences it and sets bit4 when loopbackMode2. Do not infer controller state5's application meaning from this comparison. Use neither synthetic loopback nor app-demo paths for real call registration.

`PeerCallZRTPImpl::_initCallConfig` (`0x1001a5048`) documents and loads its config struct: offset0 local userId,4 partnerId,8 callId,0x10 sessionId string,0x28 protocol,0x2c video bool. It sets these controller values using the named setters (`0x1001a5110..0x1001a5164`). Upstream construction still must establish the precise mapping from signaling `uidFrom`, `uidTo`, `uidN`, `id`, `sessId`, especially how local numeric native user ID differs from any obfuscated Zalo account identifier. Do not cast an arbitrary account ID to u32 just because this packet uses u32 fields.

### Relay acknowledgment, selection and token

`CallController::handleZRTPPacket` (`0x100176fbc`) handles type2 commands11/12. During ordinary initialization it searches selected servers by **source sockaddr and transport type** (`0x1001778e8..0x100177918`). On status0 it stores response token (object+0x18, parsed from successful response body wire+29) into that server's info+0x150, and response string48 into info+0x158 (`0x10017793c..0x100177950`). Nonzero status is stored as failure instead. A response alone does not imply connected media.

`setCurrentServer` (`0x100167ad4`) copies the selected server into controller+0x158; its info+0x150 token becomes controller+0x2a8, which is explicitly copied into controller+0x110 token at `0x100167bb8..0x100167bbc`. Selection can wait for additional relay responses based on configured policy; do not immediately accept an unrelated datagram's token.

`_doInitZRTP` (`0x10016e4b0`) sends all selected servers immediately, clears retry count/controller+0x128 and selected-init flag+0x125, loads configured retry limit+0x133c into+0x12c, and schedules a repeating **1000ms** JobTimer callback to `_handleInitZRTPTimeout` (`0x10017a428`). The timeout handler runs only in controller states1/2 before initialized, increments retry count, compares the configurable limit, and retries unresolved servers. Fixed global retry count is not established. Server selection can shorten the wait after the first response, also through configuration.

Server info has distinct RTP and RTCP address/port entries: offsets0 string RTP IP,0x18 RTP port,0x20 string RTCP IP,0x38 RTCP port. `_sendRequestInitZRTPToServer` validates both. TCP versus UDP is info+0x178 (TCP when1), and the method branches to the native TCP sender only when its socket path is ready; otherwise UDP serialization uses the host/port sender above. TCP framing and connect readiness are not yet reconstructed.

### Successful response string is NAT information

The successful response's string48 is **not a replacement SRTP key or sessionId** in the ordinary initialization flow. `_handleInitZRTPSuccessful` copies selected server info+0x158 (controller+0x2b0) into the saved NAT value/controller+0x698 at `0x100179764..0x100179770`, then passes controller+0x2b0 into `_p2pParseNATAddress` at `0x1001799ec..0x1001799f4`. No assignment to sessionId/controller+0xf8 appears in the inspected ordinary-success function (`0x1001791d0..0x100179ea8`). A separate server-change branch assigns previous/new requested sessionId from controller+0x528; that source is not the response string48. Do not derive a media key from this NAT address string.

The response field38 at wire25 remains semantically unresolved: the packet parser stores it, but the ordinary selected-server response handler uses status, token, NAT string and source address/type without consuming this field. Keep it opaque in the independent decoder and do not overwrite the negotiated call ID with it.
