# ZRTC capability and SRTCP contract

Static evidence, 2026-10-21. Target: `/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall`, universal SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`. Unslid arm64 virtual addresses below refer to `/tmp/zalo-call-analysis/helper-arm64-assembly.txt` (local assembly references, not retained REA Evidence IDs). REA decompiler unavailable; conclusions use named functions, instruction flow and field accesses. No target execution, credentials, network, signing or permission changes in this investigation.

## What is established

A replacement must generate its own effective capabilities; copying the caller's `extendData` advertises paths it may not implement. Native `getExtendData` (`0x10016871c`) initializes an object and returns it empty unless controller byte `+0xe8 == 1` (`0x100168748–0x100168750`). This gate's state meaning was not independently reconstructed here. It is not evidence that `{}` is accepted for a normal answer.

For the gated normal path, these scalar fields are serialized with the **integer** JSON constructor, including flag fields. They are not JSON booleans in this generator.

| JSON field | Effective source / behavior | Evidence |
| --- | --- | --- |
| callType | video capability disabled -> 0; otherwise byte `+0xea` | `0x100168864–0x10016889c` |
| newZrtc | controller byte `+0x430` | `0x1001688a4–0x1001688cc` |
| platform | `Utility::getPlatform()` returns **2** in this Mac build | `0x1001688d0–0x1001688fc`, `0x10015622c` |
| packetMode | effective int `+0x460` | `0x100168900–0x100168928` |
| gccMode | effective int `+0x464` | `0x10016892c–0x100168954` |
| srtpMode | effective int `+0x4c0` | `0x100168958–0x100168980` |
| sP2P | effective byte `+0x4ca` | `0x100168984–0x1001689ac` |
| srtcp | effective byte `+0x4c8` | `0x1001689b0–0x1001689d8` |
| gccAudio | effective byte `+0x468` | `0x1001689dc–0x100168a04` |
| gccSVLR | effective byte `+0x469` | `0x100168a08–0x100168a30` |
| tpType | controller int `+0x2d0 == 1` -> 1, else 0 | `0x100168a34–0x100168a64` |
| spTcp | controller int `+0x2d4 != 0` -> 1, else 0 | `0x100168a68–0x100168a98` |
| gccEarlyCall | effective byte `+0x46a` | `0x100168a9c–0x100168ac4` |
| supportCallBusy | int `+0x181c` | `0x100168b48–0x100168b70` |
| supportHevcDecode | literal 0 at the final value construction in this build | `0x100168b84–0x100168bac` |
| fecTP | int `+0x1824` | `0x100168eb8–0x100168ee0` |

Additional output is conditional: `p2p` when config byte `+0x16f2 == 1`; nested `video.codec` when `+0x16f3` is enabled; `maxFT` when GCC audio is enabled and configured frame time positive; `extraInfo` only if stored value is an object; `select2side`, server choice/count results and `serverAddr` depend on selection mode/server state. `platform` is assigned again near return (`0x100168e88–0x100168eb4`). Do not treat these conditional fields as universally required. Do not advertise video/TCP/P2P/GCC/FEC support solely to mimic the native object.

### More detail on the conditional server fields

The disassembly shows `getExtendData` has a video/server-selection branch in addition to its scalar capability fields (`0x100168bb0–0x100168e84`). In one path it walks server records and filters for a nonzero record flag at `+0x150` and a record type matching controller `tpType` at `+0x178`, then appends `ZRTPServerDualIpHelper::getJsonObject` output to `serverResult` (`0x100168c40–0x100168c90`). The alternate path emits `select2side` and computes `numServers` from the server-result vector (`0x100168ca4–0x100168d18`). A later path builds address objects with `getAddressJsonObject`, and can emit `serverAddr`; near return it may also add `fecTP` (`0x100168d64–0x100168ee0`). The low-level gates depend on video/controller flags and stored server metadata, so these fields cannot safely be populated by copying `params.servers` or the first offered relay endpoint.

The active answer relay is independently exposed through `getCurrentRtpServer` and `getCurrentRtcpServer`; it must follow the relay registration that actually succeeded. The `serverResult`/`serverAddr` values are capability/selection metadata, not proof that an answer should echo them as the selected audio endpoint. This investigation still does not identify the smallest answer object accepted by a current peer.

In this follow-up, REA's read-only Mach-O inspection confirmed that the installed universal binary still has SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e` and the saved disassembly's arm64 slice is the matching artifact. The REA decompiler provider is unavailable on this machine, so the new interpretation above is based on the existing arm64 instruction listing and field accesses, not newly generated pseudocode or runtime behavior.

**No proven minimum accepted answer JSON is available.** Native constructor defaults and parser fallbacks do not prove the peer/server will accept a synthetic capability subset. In particular, platform2 describes this artifact, not a recommendation to disguise an independently implemented Linux server as a Mac client.

## Negotiation and fallback rules

`_parseExtendData` starts at `0x100162ba4`. Its integer getter calls pass default0 for fields below. It first requires a parsable object; a parse failure/non-object takes `0x100163068–0x100163094`, clearing effective SRTP/RTCP/P2P and GCC options, setting packetMode2 and max frame time60. There are further fields after this block; this is not a full call acceptance validator.

1. **packetMode:** remote integer defaults0. It must equal current local packetMode and be nonnegative; mismatch/negative sets effective mode2 (`0x100162e38–0x100162e78`). `parseCallConfig` also replaces configured values less than1 with2 (`0x10015dd10–0x10015dd20`). Thus omitting packetMode does not preserve an arbitrary initial packetMode.
2. **gccMode:** compares remote default0 with configured local `+0x13a8`; mismatch sets effective0 (`0x100162eb0–0x1001630c4`). GCC audio, early-call and SVLR flags are retained only when their local and remote booleans agree; effective GCC mode must also be1 (`0x100162ee4–0x1001630d4`).
3. **srtpMode:** remote default0 compared with cached initial local mode `+0x4c4`. Equal -> effective cached mode; mismatch ->0 (`0x1001630d8–0x100163138`). This is equality negotiation, not choosing the strongest common suite.
4. **srtcp:** remote integer default0 compared with cached initial local RTCP flag `+0x4c9`. Mismatch clears effective byte `+0x4c8`; equality retains its current low bit (`0x100163154–0x1001631b8`). A remote true JSON boolean is not established as equivalent to integer1 in this getter; preserve evidenced integer form.
5. **sP2P:** same comparison against cached local byte `+0x4cb`; mismatch clears effective `+0x4ca` (`0x1001631d4–0x100163234`).
6. If effective SRTP mode <1 or fails `SupportSrtpCrypto`, native clears mode, srtcp and sP2P, and invokes clear-SRTP callback (`0x100163250–0x100163280`). Supported profiles are exactly1,2,3 (see SRTP report).

`parseCallConfig` copies configured `srtpRTCP` and `sP2P` only when validated SRTP mode is nonzero (`0x10015dc14–0x10015dc48`); it attempts transport initialization before caching mode/flags. Setup failure clears all three; successful setup caches actual mode and flags at `+0x4c4/+0x4c9/+0x4cb` (`0x10015dcb0–0x10015dd0c`). Thus advertisements must reflect successful local crypto setup.

**Mode0 is a real native fallback branch**, with transport selection becoming null and media bytes bypassing SRTP. This is static evidence of compatibility code, not proof a current Zalo peer/server permits an engine-free unencrypted call. Do not force a configured encrypted offer to0 merely because profile3/noSeq/SRTCP are not implemented; reject unsupported capabilities until an authorized interoperability test establishes a supported negotiated alternative.

`srtpNoSeq` is read from call configuration, not advertised as an `extendData` member in this generator. It is supplied as both audio and video noSeq arguments to transport creation (`0x10015dcbc–0x10015dcd4`), while the final SSRC-zeroing boolean is false. Nonzero noSeq forces profile3 and zeroes/restores RTP sequence around crypto. Existing `src/call/srtpRtp.ts` explicitly does not support this compatibility behavior. See [SRTP findings](zrtc-srtp-findings.md).

## RTCP namespace and encryption boundary

Do not confuse outer relay **type** with type127 **command**:

| Media | Relay outer type | P2P type127 command |
| --- | --- | --- |
| Audio RTP | 3 on send / 4 on receive | 6 |
| Audio RTCP | **5** | **7** |
| Audio FEC | **7** | **10** |
| Video RTP | 13 / 14 | 8 |
| Video RTCP | 15 | 9 |

Evidence: `ZRTPPacket::initZRTPPacketAudio` `0x100157d50–0x100157da4`; FEC initializer `0x100157dcc–0x100157e0c`; video initializer `0x100157e10…`; receive dispatch `0x1001bcd30–0x1001bce60`. Audio RTCP producer `Peer::onSendAudioRtcp` passes final boolean1 at `0x1001b3ff4`, initializes wrapper, copies original RTCP body to packet storage at `+0xeb` (`0x1001b3ffc–0x1001b400c`).

There is **no separate SRTCP bit in this audio wrapper initializer**. The same RTCP identity is used; effective local negotiated `srtcp` controls whether the body is protected. `Peer::getSRTP` (`0x1001a20e8`) selects audio SRTP transport `+0x2e28` for relay types3/4 unconditionally when the transport exists, and relay type5 **only if `getSrtpRTCP()` is true** (`0x1001a2198–0x1001a21e8`). It selects video transport `+0x2e20` for types13/14, and type15 only with that flag. A null transport means the media body proceeds without this crypto transform.

Send ordering is exact: `sendMediaPacket` asks `getSRTP`, calls `SrtpTransport::OnSendPacket` on **body only**, writes back expanded length, then `ZRTPPacket::buildPacket` wraps it (`0x1001a9280–0x1001a92e4`). Failure returns without sending. Receive ordering is reverse: `_processReceiveZRtcPacket` obtains transport and calls `OnReadPacket` on parsed body before dispatching RTCP to `AudioRtpRtcp::receiveAudioRtcpPacket` (`0x1001bcce4–0x1001bcdd8`). Outer header/token must not be passed as RTP/SRTCP plaintext.

`OnSendPacket` classifies body RTP versus RTCP using `InferRtpPacketType`, calling `SrtpSession::ProtectRtcp` for RTCP (`0x100299938–0x100299990`). `OnReadPacket` similarly calls `UnprotectRtcp` (`0x100299600–0x100299658`). Consequently, RTP-only crypto cannot handle type5 by treating RTCP as an RTP header/payload.

### Follow-up: exact relay SRTCP gate and body transform

The negotiation and transport branches now line up end-to-end:

1. Local `srtpRTCP` is cached as the initial RTCP flag only after SRTP setup succeeds (`CallController::parseCallConfig`, `0x10015dcb0–0x10015dd0c`). Incoming `extendData.srtcp` is read as an integer with default0 and compared to that cached value (`_parseExtendData`, `0x100163154–0x1001631b8`). A mismatch clears the effective flag; a match keeps its low bit. The active answer capability is that effective bit (`getExtendData`, `0x1001689b0–0x1001689d8`). This is equality negotiation, not an independent “remote supports it” boolean.
2. For relay audio, `Peer::getSRTP` selects the audio SRTP transport for outer media types3/4; for outer type5 (RTCP), it selects the transport only when effective `getSrtpRTCP()` is true (`0x1001a20e8–0x1001a21e8`). Therefore the interoperable relay cases are both sides effectively0 (plaintext RTCP body) or both sides effectively1 (SRTCP body). A local true / remote0 mismatch disables SRTCP for the call; it is not safe to protect just because one config says true.
3. The wrapper is not part of the SRTCP transform. Send protects the RTCP body through `SrtpTransport::OnSendPacket`, then serializes the relay wrapper (`0x1001a9280–0x1001a92e4`). Receive unwraps, calls `OnReadPacket` on the body, then dispatches to `AudioRtpRtcp::receiveAudioRtcpPacket` (`0x1001bcce4–0x1001bcdd8`). `SrtpSession::ProtectRtcp`/`UnprotectRtcp` directly call libsrtp `srtp_protect_rtcp`/`srtp_unprotect_rtcp` (`0x1002999074`, `0x10029991ac`).
4. Native profile1 uses the default RTP crypto policy for both RTP and RTCP. Profile2 uses AES-CM/HMAC-SHA1-32 for RTP but the default RTCP policy (`0x1002999298–0x10029992d4`), so RTCP authentication remains the default 80-bit tag. The existing `SrtcpContext` uses a separate SRTCP KDF (labels3/4/5), explicit E/index word, tag, and replay context. It is a protocol primitive only: the browser call adapter currently does not send/receive RTCP through it, and answer remains disabled.

There is no proven minimum capability JSON or live peer acceptance for either case. Although static code has a plaintext-RTCP fallback when the negotiated bit is0, do not select it to bypass an offered encrypted mode; only use a locally configured and mutually matched capability, and fail closed on mismatch.

Bounded P2P gap: `getSRTP` checks type127 subtypes8/15 for video and6/5 for audio in the visible code (`0x1001a2144–0x1001a2228`), while the producer/receiver uses7 for audio RTCP and9 for video RTCP. No transformation reconciling these was established here. Do not extrapolate relay RTCP crypto gates to P2P; start with relay-only and keep P2P unsupported.

## Concrete implementation sequence

1. Parse incoming `zrtc_config` and `extendData` independently; validate profile, exact30-byte key, noSeq and transport route before showing a supported-call action. Keep keys and raw session values out of logs.
2. Implement effective capability negotiation with the evidenced integer types, packetMode fallback and equality checks. Unit fixtures must distinguish local configured, initially successful and finally negotiated flags. Do not blindly echo incoming `extendData`.
3. Add SRTCP primitives/context if advertising `srtcp:1`: independent RTCP packet index and replay/authentication handling, correct RTP-versus-RTCP policy (profile2 RTP32-bit auth still has RTCP default80-bit auth), bounded expansion buffers and compound RTCP validation. Existing RTP tests do not validate this layer.
4. Route audio relay type5 through SRTCP only when effective srtcp is1; preserve plaintext RTCP path only when validly negotiated. Authenticate/decrypt after unwrap and before RTCP parse; protect before wrap.
5. Build RTCP SR/RR/SDES and source stats with selected SSRC/RTP clock; keep report scheduler and teardown independent of RTP sender. Exact native scheduling and mandatory feedback subset remain another investigation.
6. Gate browser acceptance on successful relay registration and media initialization, then construct the accepted402 from actual negotiated state. Require remote ACK/confirmation separately from HTTP success.
7. Prove no-engine interop with an owned inbound call, no ZaloCall process, real outbound microphone speech, authenticated incoming speech, browser hangup and a clean second call. No evidence in this static pass satisfies that runtime gate.

Remaining unknowns: minimum capability subset accepted by present peers; live negotiated crypto/noSeq/profile; exact packetMode wire choices; P2P discrepancy above; required RTCP feedback/report intervals; and real remote speech. The independent implementation should fail clearly on these unknown paths instead of announcing a connected voice call.
