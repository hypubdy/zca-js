# Tiến thêm RTCP report độc lập — 2026-10-21

> Nhật ký từng bước và tài liệu luồng kết nối/API: [dịch ngược phiên hôm nay](docs/reverse-engineering/zalo-call-re-session-2026-10-21.vi.md), [luồng call, nghe event, answer và end](docs/reverse-engineering/zalo-call-connection-flow.vi.md). Đọc hai file này trước để nắm bằng chứng, API và các điểm còn chặn.

## Tiếp tục: snapshot offer an toàn cho lần thử phối hợp

`IndependentCall.observe(request)` nay phát event `independent-offer` sau khi
parse được offer. Snapshot chỉ gồm codec `payload/frmPtime/dynamicFptime`,
family/port của RTP và RTCP, platform/protocol, và allowlist capability
`srtpMode/srtcp/...`. Không ghi UID, call/session ID, địa chỉ IP nguyên văn,
`srtpKey`, token, hay trường capability không nhận diện. React đưa snapshot này
vào Nhật ký phiên; test dùng sentinel xác nhận không rò identifier hoặc key.
Đây là bước thu thập dữ liệu an toàn cho incoming call thật, không mở answer
gate hay xác nhận tương thích. `mediaReady` vẫn false.

## Kết quả offer thật và thử relay — 2026-10-21

Demo `4318` đã online và ghi `request` lúc `2026-10-21T14:20:18.985Z`, sau đó
`cancel` lúc `14:20:43.037Z`. Offer parse thành công: protocol3, RTP/RTCP IPv4
cùng port4200, Opus 48k stereo PT113 và 16k mono PT112, frame20ms,
`extendData.srtpMode=1`, `srtcp=0`, `packetMode=2`; `zrtc_config` có
`srtpMode=1` nhưng không có `srtpRTCP`. Không lưu IP/session/key/UID.

Thử relay registration trên offer kế tiếp lúc `14:22:29` ban đầu dừng ở local
`srtpRTCP` thiếu trước khi phát gói. Theo `ZRtcConfig::fromJson` bool field
semantics, trường bị thiếu mặc định false; cập nhật adapter theo mặc định native
và giữ mismatch fail-closed. Synthetic test kiểm tra remote `srtcp=0` được chấp
nhận thành SRTCP-disabled, còn remote `srtcp=1` vẫn bị từ chối. Toàn bộ demo
14/14 pass. Sau restart và QR login, incoming offer mới lúc `14:25:46.911Z`
đăng ký relay thành công lúc `14:26:09.014Z`: Opus 48k stereo PT113,
SRTP-RTP sẵn sàng, remote SRTCP=0 nên dùng RTCP clear, UDP socket persistent
và keepalive6s. Backend vẫn báo `mediaReady=false`; chưa answer, mở mic hay gửi
voice. Không thấy xác nhận peer nhận media.

Đã thêm answer trial thủ công: sau relay registration và khi browser audio
session được dựng, UI gửi API 402/status0 bằng codec đã chọn, endpoint relay
thành công và capability candidate tối thiểu cho profile1 / RTCP clear / UDP
relay. HTTP success chỉ chuyển sang “waiting ACK”; mic RTP vẫn gated tới khi
event answer_ack cùng call ID được quan sát. Unit test kiểm tra payload
candidate, không xác nhận peer interop. Toàn bộ demo suite nay 16/16 pass.
Backend đã restart trên `4318` để nạp thay đổi và đang offline; cần QR login
lại. Bước live tiếp theo: incoming call → register relay → browser mic/loa
permission → bấm “Thử nhận cuộc gọi” → quan sát HTTP response/peer ACK → nếu ACK
tới thì thử nói-nghe hai chiều. Candidate capabilities, ACK action spelling,
remote audio và RTCP cadence vẫn cần live validation.

Đã lần đường native RTCP qua WebRTC `RTCPSender`: `AudioRtpRtcp::_create` bật
config byte khiến `RtcpReportInterval()` trả2500ms; `ModuleRtpRtcpImpl::Process`
chỉ gọi send khi scheduler `TimeToSendRTCPReport` cho phép. Đây là giá trị
interval đưa cho WebRTC, không chứng minh nhịp gửi cố định 2.5 giây. WebRTC ráp
compound SR hoặc RR cùng SDES/CNAME, rồi `Peer::onSendAudioRtcp` chuyển body qua
relay type5; crypto chạy trước outer envelope. Assembly và địa chỉ cụ thể ở
`docs/reverse-engineering/zrtc-srtp-findings.md`.

Thêm builder/parser compound SR/RR + SDES/CNAME và nối adapter qua hai context
SRTCP độc lập: send protect → relay type5; receive type5 unwrap → authenticate /
unprotect → parse report blocks. RTCP receive state tính sequence wrap, loss,
jitter, LSR/DLSR; report gửi kèm RR block khi đã nhận RTP và SR counters khi đã
gửi RTP. Chỉ khởi tạo context khi local/remote `srtcp` khớp; gửi report yêu cầu
call confirmed và CNAME tường minh. Round-trip synthetic type5 và mismatch
fail-closed tests pass. `build:esm`, 16 test protocol trọng tâm (86 assertions),
lint, demo build và cả 12 test demo pass; ICE/DTLS loopback pass khi được phép
dùng local sockets. Thêm accepted-402 body builder nhận codec, địa chỉ relay đã
chọn và capabilities do caller tạo; builder chưa gửi answer vì minimum
`extendData` được peer chấp nhận vẫn chưa rõ. Chưa có scheduler, nguồn CNAME
native hay peer interoperability. `mediaReady` vẫn false và nút nhận vẫn khóa.
Bước kế: xác minh capability answer/ACK, CNAME/cadence với incoming call phối
hợp; sau đó mới nối retry/confirmed/end lifecycle.

---

# Bổ sung reverse engineering SRTCP và capability gate — 2026-10-21

Tiếp tục phân tích tĩnh đúng binary `ZaloCall` SHA-256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`; dùng
arm64 assembly tại `/tmp/zalo-call-analysis/helper-arm64-assembly.txt`, không
chạy engine/cuộc gọi.

Đã nối logic SRTCP qua ba tầng native: local `srtpRTCP` chỉ được cache sau khi
SRTP setup thành công; `_parseExtendData` so sánh `extendData.srtcp` kiểu số
nguyên với giá trị local; lệch nhau thì tắt effective SRTCP. Relay audio type5
đi qua SRTP transport chỉ khi effective flag bật. Native bảo vệ body RTCP rồi
mới đóng relay envelope; chiều nhận tháo envelope trước rồi mới unprotect và
giao plaintext cho RTCP parser. Với profile2, RTP dùng HMAC-SHA1-32 nhưng RTCP
dùng policy mặc định 80-bit. Evidence và địa chỉ chi tiết ở
`docs/reverse-engineering/zrtc-capabilities-contract.md` và
`docs/reverse-engineering/zrtc-srtp-findings.md`.

`src/call/srtcp.ts` đã có primitive profiles1/2. Thêm
`test/srtcp.ts`: 6 test/23 assertions pass cho E/index, auth, encryption,
replay, clear-E mode, profile2's 80-bit RTCP tag, malformed packet, direction
và teardown. Bắt được rồi sửa lỗi JS signed bitwise khi set E-bit. Đây là test
invariant/offline, không phải RFC packet known-answer hay Zalo interop.
Adapter web vẫn chưa tích hợp relay type5 hay RTCP scheduler, và
chưa biết capability tối thiểu nào được peer chấp nhận. Do đó `mediaReady`
tiếp tục false và Answer vẫn khóa. Bước kỹ thuật tiếp theo: dựng RTCP report
đúng sender/receiver state, nối protect/unprotect qua relay type5 và chỉ sau
đó thử incoming call phối hợp; không gửi answer trước khi hai chiều RTCP và
capability qua gate. RFC 3711 §3.4 là chuẩn tham chiếu cho packet layout,
không phải bằng chứng Zalo interop.

---

# Bổ sung reverse engineering audio frame-time — 2026-10-21

Tiếp tục phân tích tĩnh binary arm64 `ZaloCall` đúng SHA-256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.
Decompiler provider (Hopper/Ghidra) chưa có trên máy; không cài thêm và không
chạy engine/cuộc gọi. Dùng disassembly đã lưu tại
`/tmp/zalo-call-analysis/helper-arm64-assembly.txt`.

Điểm mới: `AudioCodecItem::parseJson` coi `dynamicFptime` là bật chỉ khi JSON
integer đúng bằng1 (`0x10015e3b4–0x10015e3f0`). Nhánh merge ở
`CallController::negotiateCodec` (`0x100161f54–0x100161f94`) cho ra0 nếu một
bên tắt; nếu cả hai bật thì chỉ chọn60 khi cả hai đều là60, còn lại dùng
`frmPtime` đã validate (fallback20ms). `frmPtime` có thể tiếp tục thay đổi khi
Audio Network Adaptor gọi `AudioEncoderOpusImpl::SetFrameLength`
(`0x10036dc2c–0x10036dc84`), qua `Peer::adjustFptime` và
`AudioDevice::setEncodeFrameLength`. Packetizer gom theo số khối PCM10ms và
kiểm tra chia hết cho10 (`0x10036d470`, `0x10036d4f8`). Bóc tiếp phép nhân/
rotate tối ưu trong validator `Utility::isFrameTimeValid`
(`0x100156234–0x10015625c`) cho thấy tập hợp dương hợp lệ là20,40,60,80,100,
120ms; các giá trị khác và0 bị loại. Bridge cần giữ frame duration hiện hành
và đổi PCM accumulation, pacing, RTP timestamp cùng một thời điểm. Đây là kết
quả diễn giải static predicate, không chứng minh call live dùng toàn bộ tập
này; việc network adaptation được bật cho từng cuộc gọi vẫn chưa biết.

Chi tiết và bằng chứng được bổ sung vào
`docs/reverse-engineering/zrtc-negotiation-findings.md` và
`docs/reverse-engineering/zrtc-audio-contract.md`. Decompiler còn thiếu nên
đây là diễn giải control/data flow arm64; chưa có live trace hay kiểm chứng
interop. Bước RE kế tiếp: theo dõi frame-length update tới RTP sender/timestamp
clock và đối chiếu bằng trace được phép. Không biến findings tĩnh này thành
quảng cáo capability hay bật nhận cuộc gọi.

---

## Yêu cầu ưu tiên hiện tại: bỏ hoàn toàn ZaloCall — 2026-10-21

Mọi kiến trúc sidecar/native UI/process tap phía dưới đã bị yêu cầu này thay thế.
Đọc docs/reverse-engineering/independent-call-engine.md trước: checkpoint mới có code, bằng chứng và bước tiếp theo.

Đã RE sâu negotiation/relay/SRTP, triển khai src/call/{negotiation,zrtpPacket,relayRegistration,srtpParameters,srtpRtp,index}.ts. Export experimentalCallProtocol. 21 protocol/signaling tests/129 assertions pass, gồm RFC3711 KDF/AES-CM vectors và UDP relay localhost, không dùng engine native. Ba báo cáo mới zrtc-{negotiation,transport,srtp}-findings.md có địa chỉ assembly và unknowns.

Tiếp tục RE static 2026-10-21: thêm `relayMediaPacket.ts` codec relay media riêng chiều (TX RTP3/RX RTP4, RTCP5, FEC7 opaque); sửa parser negotiation giữ `platform`/`protocol` dạng integer native; thêm báo cáo audio/SSRC/Opus, capability/SRTCP, relay lifecycle. Lộ trình: `docs/reverse-engineering/engine-free-call-roadmap.vi.md`. Native upstream chọn type127 command6/7 khi P2P đang chạy; voice relay thường dùng legacy type3/4, RTCP5. Keepalive đã quan sát là 6000ms; init retry tick 1000ms nhưng giới hạn lấy từ config. PT112 Opus16k mono/PT113 48k stereo có trong native; sample/timestamp và browser bridge chưa được xác thực trực tiếp.

Đợt triển khai hiện tại thêm `ZrtpRelaySession` (UDP socket bền, retry giới hạn, keepalive6s, TX/RX relay envelope, relay-end khi dọn), `rtpAudio.ts` (parse RTP2, CSRC/extension/padding, sender sequence/timestamp), `opus-gateway.mjs` (libopus WASM và PCM conversion cho 16k mono/48k stereo) và `srtcp.ts` (primitive mới nhưng chưa test/enable). Nút demo “Kết nối relay độc lập” gọi persistent registration có chủ ý; vẫn không answer/mở mic. `bun run build:esm`, JS syntax checks và demo `npm run build` pass. Chưa chạy test theo yêu cầu triển khai hiện tại. Chưa có live answer/speech độc lập, SRTCP interop, profile3/noSeq hay browser-to-Zalo audio bridge.

Backend mặc định examples/call-web-demo/server.mjs không import/khởi chạy NativeHelper, không dùng IPC/AX/process tap/CoreAudio. helper RPC cũ bị từ chối; mode Zalo media chưa thực hiện nên nút Nhận disabled. Mode tone/echo WebRTC còn hoạt động; build demo chỉ build React, không compile native bridge. Adapter independent-call.mjs chỉ đọc offer và cho probe relay explicit từ browser; probe đóng socket và KHÔNG nhận call. Không tự quay về engine Mac.

Đã đăng nhập lại backend độc lập thành công. Cần live incoming để kiểm tra offer/relay; chưa có incoming mới trong cửa sổ theo dõi. Secrets trong RAM, không lưu. 10 demo tests, browser mic-controls và full browser tone/echo/mobile pass. Backend nativeEngine=false, legacy helper-start bị từ chối; không gọi đây là hoàn thiện call.

Tiếp theo: kiểm tra offer/capability đúng với cuộc incoming được phối hợp -> SRTCP/profile negotiation -> tìm/đưa vào Opus codec độc lập và nối PCM WebRTC tới RTP sender/receiver -> chỉ khi các phần đó media-ready mới bật answer402/answer_ack -> E2E hai chiều/end/nextcall. Standard SRTP hiện chỉ profile1/2, chủ động không hỗ trợ profile3/noSeq. Đường media độc lập chưa xong.

---

## Tiếp tục nối audio độc lập — 2026-10-21

Đã nối bridge mới trong `examples/call-web-demo`: WebRTC `RTCAudioSink` nhận PCM mic từ browser; callback đi qua `IndependentCall.sendBrowserPcm()` → Opus encoder → RTP/SRTP → relay. Hướng RX unprotect/authenticate → Opus decode → `RTCAudioSource` queue → WebRTC/browser speaker. `confirmed` vẫn gate mic TX. Server chỉ mở mode Zalo browser leg nếu relay, codec và RTP SRTP context sẵn sàng; khi stop thì gỡ decoded-PCM callback.

UI giờ cho chuẩn bị browser bridge khi `browserBridgeAvailable`, nhưng `mediaReady` luôn false và “Nhận cuộc gọi” vẫn khóa. Lý do cụ thể: call path từ chối SRTCP, chưa có `extendData` capability builder tương thích/được peer chấp nhận, nên không gửi answer giả. Chưa có jitter buffer/RTCP lifecycle và timestamp/SSRC interop chưa được xác nhận. File README, roadmap và checkpoint đã cập nhật để phân biệt bridge code với cuộc gọi thật.

Đã chạy `bun run build:esm`, `npm run build` trong demo và `node --check` cho server/media/independent adapter; đều pass. Không chạy test suite trong lượt này. Không có xác nhận live relay/audio hoặc cuộc gọi end-to-end. Tiếp theo nghiên cứu/kiểm chứng SRTCP + capability negotiation với một incoming call phối hợp; chỉ sau đó mới nối answer/ACK, mở TX gate và xử lý end. Không dùng cookie/credential đã dán trong lịch sử; nếu cần tài khoản phải login chủ động trong UI và không ghi secret vào file/log.

---

## Yêu cầu mới nhất: chỉ thao tác trình duyệt — 2026-10-21

Người dùng không muốn nhận ở cửa sổ Zalo Mac: Nhận/Kết thúc/Mic/Loa đều ở web. Đừng yêu cầu họ bấm cửa sổ native nữa.

Đã thêm mic mute/unmute (track.enabled), đổi nút Dừng thành Kết thúc cuộc gọi ở mode Zalo; loa/âm lượng qua WebAudio. Nhận khi nguồn cũ là tone phải thay sender sang mic thật trước khi nhận. Browser-controls test (mic giả) pass mute/unmute/speaker/track cleanup. 8/8 tests pass.

Server call-accept chỉ thử exact unique AX button (thêm identifier btnAccept theo string native), đợi cửa sổ tối đa4.5s, press rồi hide helper. Nếu không được, trả lỗi chưa hỗ trợ nhận hoàn toàn trên web; đã bỏ fallback bắt người dùng thao tác Mac. Đây vẫn là adapter native phía backend, KHÔNG engine ZRTC độc lập và CHƯA được chứng minh nhận được bằng web.

Runtime cũ thực sự thấy request 12:06:46Z -> native402/answer12:07:10Z -> answer_ack -> mute_audio -> end_call12:07:45Z -> nativefree. Chưa biết người dùng bấm nhận bằng cách nào. Native RX PCM outputRms vẫn0; không xác nhận được voice. Phát hiện end_call không được nhận diện trước đó nên mic giữ mở; đã bổ sung terminal action này và nativefree đóng media/mic. Cho phép signaling cleanup405/406/409 sau audio teardown để end/log không bị isLive chặn.

REA native: open_binary thành công; analyze_function không có provider. Static nm/assembly: btnAcceptClick0x100052bb4, Qt metacall entry0x10013245c, method available in-process nhưng không có cross-process IPC. Hardened runtime entitlements không có get-task-allow, disable-library-validation, allow-dyld-environment-variables. Không sửa signing/cài plugin/inject bypass. noNeedAnswer chỉ là config bool parse, chưa có bằng chứng autoaccept; không bật dựa theo tên.

Mấu chốt còn lại: tạo được backend accept đáng tin cậy hoặc triển khai ZRTC engine độc lập; AX automation chưa pass live call. Nếu người dùng cấm cả engine Mac chạy nền thì kiến trúc hiện tại không đáp ứng, cần nói rõ. Không gọi đây là hoàn tất full browser call.

---

## Sửa lỗi nhận sự kiện — 2026-10-21 khoảng 19:00

Người dùng báo chưa nhận/nghe được. Kiểm tra runtime thấy `zalo-state:disconnected` lúc 10:41:17Z nhưng snapshot vẫn online do adapter không cập nhật this.state. Last media có mic RMS ~0.0025 và native RX RMS=0; không có bằng chứng cuộc gọi đã connect. Không kết luận route PCM đã đủ để gọi thật.

Đã sửa ZaloSession: chỉ online khi listener emit connected; disconnect cập nhật state, clear pending, giữ numeric close code; retry transient giới hạn 8 lần exponential backoff; không tự tranh kết nối khi code3000/3003/1000. Có RPC/UI “Kết nối lại sự kiện” cho phiên đang giữ trong RAM. Logout hủy timers và vô hiệu callback cũ. Đã loại native playback telemetry khỏi lifecycle log để tránh mất request/cancel.

7/7 demo tests pass gồm 2 regression tests trong test/zalo-session.test.mjs; TypeScript --noEmit pass. Đã restart server và credential login thành công; listener thực sự online. Đang yêu cầu người dùng gọi lại để xác định bước lỗi tiếp theo. Chưa biết close code của phiên cũ vì trước đó không ghi code; KHÔNG khẳng định nguyên nhân là duplicate connection.

---

## Cập nhật mới nhất — 2026-10-21, nghe/nói qua process tap

Ưu tiên mục này hơn các đoạn cũ yêu cầu hai virtual bus. Tuyến đang chạy:

- RX: ZaloCall PID do server sở hữu → private CoreAudio process tap → PCM16 mono 48 kHz → WebRTC → loa browser.
- TX: mic browser → WebRTC → PCM worker playback-only → Microsoft Teams virtual audio → mic của ZaloCall.
- Tap mute output trực tiếp của riêng ZaloCall; browser nghe qua WebRTC. Không cài driver thứ hai, không capture toàn hệ thống.
- Native cần macOS 14.2+ và quyền System Audio Recording. Nút nhận dùng Accessibility exact-match duy nhất, fallback nhận trong cửa sổ native nếu Qt không expose nút.

Đã build cả React, pcm-bridge, process-tap và helper-ui. 5/5 unit/WebRTC tests pass ngoài sandbox (ICE không kết nối trong sandbox).
`test/tap-gateway.mjs` pass: 96.000 RX samples, âm RX 440 Hz amplitude 0.048984, TX 880 Hz leak 0.00000425; cả nativeReady và tapReady true.
Chrome smoke với ZaloCall thật đã pass: gửi >51k samples, nhận >50k silence samples khi idle, không drop. Không đặt cuộc gọi outbound. **Chưa chứng minh tiếng nói Zalo ở đầu xa.**

Server mới đang chạy http://localhost:4317 bằng `npm start -- --credential-stdin`, đã login connected=true/voiceServiceAvailable=true. Secrets chỉ ở RAM; không lưu vào tài liệu/file.
Người dùng cần reload web, gọi đến account, bấm “Nhận qua mic / loa trình duyệt”, cho phép mic. Nếu báo fallback thì bấm nhận ở cửa sổ ZaloCall. Xác nhận nghe hai đầu, rồi kiểm tra kết thúc/cleanup.
Request nhận trước media được giữ tối đa 60s trong RAM và forward sau khi cả TX worker và RX tap ready. Không coi IPC ACK hay AXPress là call connected.

Các file mới: native/process-tap.mm, native/tap-tone.c, native/helper-ui.m, build-tap.mjs, build-ui.mjs, test/process-tap.mjs, test/tap-gateway.mjs. MediaSession có route `process-tap-rx/virtual-tx`; server chọn speaker physical riêng cho helper và mic virtual TX. Các file còn lại đã chỉnh pending/accept/UI theo tuyến này.

Bước tiếp theo là kiểm chứng incoming call thật và sửa lỗi signaling/native state nếu xuất hiện; không quay lại kết luận cần hai driver. Test tổng hợp không thay thế cuộc gọi thật. Chạy test/process-tap.mjs để build fixture trước test/tap-gateway.mjs.

---

# Bàn giao session: Zalo call audio stream và demo React

## Cập nhật mới nhất: đăng nhập bằng credential đã thành công

**Theo dõi cuộc gọi thật sau đó:** người dùng gọi vào tài khoản; server thực sự
ghi nhận `incoming-control/request` lúc `2026-10-21T10:14:01.240Z`, rồi `cancel`
lúc `10:14:22.485Z`. Đây là bằng chứng nhận signaling từ cuộc gọi thật, **chưa
phải nhận/đàm thoại hay remote PCM**. Demo lúc đó chỉ append nhật ký, không có
banner; không chuyển control sang helper vì `isLive()` false khi chưa bật
media mode Zalo. Không nhầm việc thiếu hai bus audio với việc listener không
nhận sự kiện: listener đã nhận được request/cancel.

Đã sửa frontend để hiện banner cuộc gọi đến độc lập với media, xử lý cancel,
timeout và phục hồi lịch sử từ snapshot khi reload. File mới:
`examples/call-web-demo/web/call-notification.mjs`; có 2 test pass tại
`test/call-notification.test.mjs`. Build đã cập nhật, không restart backend
để giữ phiên đăng nhập memory. Người dùng cần reload trang để nhận JS mới.
Không có nút Answer giả: vẫn thông báo rõ audio bridge chưa bật và nhận native
UI chưa được nối hoàn chỉnh.

Sau baseline demo dưới đây, người dùng đã cung cấp credential trong chat và
cho phép đăng nhập để thử call. Đã thực sự đăng nhập thành công vào server demo:
`connected=true`, `voiceServiceAvailable=true`; helper cũng đã init/query thành
công với phiên này. **Chưa gọi Zalo thật hoặc xác minh audio từ đầu bên kia.**

- Server vẫn ở `http://localhost:4317`, phiên chỉ giữ trong memory; không lưu
  cookie/IMEI/userAgent vào source, credentials file, log hay tài liệu này.
- Đã thêm `ZaloSession.loginCredentials()` dùng chung `attachApi()` với QR login,
  và server flag `--credential-stdin` để nhận JSON ẩn qua terminal.
- Chạy `npm start -- --credential-stdin` nếu cần cơ chế nhập này. Dùng terminal
  không echo và noncanonical mode để JSON dài không bị giới hạn buffer PTY;
  không truyền credential bằng shell arguments, URL hoặc in ra stdout.
- Nếu server restart thì phiên mất; xác minh `/api/status` trước khi yêu cầu
  người dùng đăng nhập lại. Không chép credential từ chat vào tài liệu bàn giao.
- Đã hỏi người dùng tài khoản đích/Zalo user ID và đầu điện thoại phối hợp;
  tại thời điểm cập nhật chưa nhận câu trả lời, chưa tự chọn người để gọi.
- Vẫn cần kiểm tra hai virtual bus độc lập và khả năng worker hỗ trợ format;
  không bypass chặn single-bus của chế độ Zalo thật.

Các đoạn “chưa có credential” phía dưới mô tả baseline trước cập nhật này.
QR login vẫn chưa được thử; credential login pass không chứng minh cuộc gọi
hoặc web-session/native media interoperability đã pass.

**Cập nhật: 2026-10-21 · Repo: `/Users/tunv/zca-js` · Máy macOS arm64.**

Đây là tài liệu khởi động lại công việc cho AI ở session sau. Đọc hết file này
trước khi đề xuất lại kiến trúc hoặc sửa code. Các đường dẫn tương đối tính từ
root repo. Trạng thái tiến trình và file trong `/tmp` có thể đã thay đổi.

## 1. Người dùng muốn gì

Mục tiêu cuối: **audio stream hai chiều trong cuộc gọi Zalo**, không phải gửi
tin nhắn thoại, không phải chỉ signaling, không phải ghi âm rồi upload.

- Giao diện React chạy trong trình duyệt, dùng mic/loa của người dùng.
- Backend `zca-js` quản lý phiên Zalo và cuộc gọi.
- Trình duyệt gửi/nhận audio realtime qua server; sau này có thể nối TTS/STT.
- Người dùng đã yêu cầu thực nghiệm nhiều hướng và chọn theo bằng chứng, không
  chỉ viết kế hoạch. Đã thực nghiệm và chọn hướng bên dưới.
- Yêu cầu gần nhất: ghi tài liệu bàn giao thành một file để session mới tiếp tục.

**Đừng báo là gọi Zalo thật đã chạy được. Hiện chỉ audio gateway local và IPC
native đã được chứng minh.**

## 2. Quyết định kiến trúc đã chọn

Chạy **helper `ZaloCall` hiện hành như sidecar trên Mac**, điều khiển bằng IPC,
và nối PCM qua **hai bus audio ảo tách biệt RX/TX**.

```text
React / trình duyệt
  mic -> WebRTC -> Node RTCAudioSink -> PCM -> bus TX -> mic của ZaloCall
  loa <- WebRTC <- Node RTCAudioSource <- PCM <- bus RX <- loa của ZaloCall
                                                          |
                                                   cuộc gọi Zalo
                                                          |
                                                     đầu bên kia
```

- `zca-js` + adapter chuyển tiếp signaling giữa HTTP/VoIP control và helper.
- `CoreAudio` worker nhận/xuất PCM16LE mono 48 kHz qua stdin/stdout.
- Browser không nạp native binary; browser chỉ dùng WebRTC.
- Worker native hiện yêu cầu macOS có audio subsystem hoạt động. Chưa xác minh
  headless/cloud Mac. Không thể mang binary Mac lên Linux VPS rồi chạy trực tiếp.
- React/backend quản lý có thể tách sang host khác về sau, nhưng demo hiện chỉ
  bind localhost. Chưa triển khai remote deployment.

Lý do chọn: helper chạy độc lập được; IPC init/query/chọn thiết bị hoạt động;
CoreAudio loopback và WebRTC↔PCM đã chạy thực tế. Tận dụng engine sẵn có giúp
tránh viết lại transport/codec/mã hóa, và tránh phụ thuộc ABI V8 cũ hoặc hook C++.

## 3. Những gì đã thực nghiệm

### Native/helper

Ứng dụng phân tích: `/Applications/Zalo.app`, phiên bản **26.10.20**.

| Đối tượng/thử nghiệm | Kết quả quan sát |
| --- | --- |
| `Contents/Resources/app.asar.unpacked/native/nativelibs/zcall/zcall_mac.node` | Chỉ x86_64; nạp vào Node arm64 thất bại `ERR_DLOPEN_FAILED` |
| Addon cũ | Symbol dùng trực tiếp V8 + `node_module_register`, không phải N-API; không chọn làm hướng chính |
| `Contents/ZaloHelper.app/Contents/MacOS/ZaloCall` | Universal arm64/x86_64, Qt 5.15.11 + CoreAudio |
| Helper do Node khởi chạy bằng hai socket riêng | Cả hai kết nối và trả `update/native-ready` |
| Chép cả `ZaloHelper.app` sang `/tmp` rồi chạy | Vẫn chạy và trao đổi IPC trên máy này; chưa chứng minh portability trên Mac sạch |
| Gửi init offline, `request/listDevice` | Có ACK và response danh sách thiết bị thật |
| Chọn virtual input/output qua IPC, query lại | Engine trả đúng GUID đã chọn |
| Thiết bị ảo Teams loopback | Gửi/nhận tone 440 Hz thành công, Float32 mono 48 kHz |
| Frida attach vào helper thử nghiệm | macOS từ chối truy cập process; chưa hook được PCM |

Audio loopback native độc lập: khoảng 96.256 mẫu/2 giây; biên độ tone gửi `0.1`,
đo nhận 440 Hz `0.09945894`; tần số đối chứng 997 Hz `0.00000827`.

Chỉ dùng socket tạm riêng, không nối vào socket phiên Zalo đang chạy. Không sửa
bundle cài đặt, không đổi code signing, không cài driver, không lấy credentials
từ ứng dụng Zalo, không đặt cuộc gọi thật trong các trial.

### Demo trình duyệt

Demo tại **`examples/call-web-demo/`**, React + esbuild, Node + `@roamhq/wrtc`
0.10.0, WebSocket control và worker CoreAudio viết bằng C.

Đã pass kiểm thử Chrome thật (headless, nguồn tone và fake microphone):

1. Server tone 440 Hz -> WebRTC -> browser, RMS nhận khoảng `0.0695`.
2. Browser tone -> WebRTC -> Node PCM -> WebRTC -> browser, RMS nhận khoảng
   `0.0698`.
3. Browser tone -> WebRTC -> PCM -> CoreAudio virtual loopback -> PCM ->
   WebRTC -> browser, RMS nhận khoảng `0.0705`. Phiên đo có 48.000 mẫu gửi vào
   native, 45.568 mẫu native trả về, không drop ở queue gateway.
4. `getUserMedia` với **fake mic của Chrome** -> gateway -> browser hoạt động.
5. Bấm Dừng kết thúc local audio tracks.
6. Bấm kiểm tra helper: IPC ready và query devices hoạt động.
7. Chế độ Zalo thật bị chặn đúng khi thiếu login/hai bus riêng.
8. Layout mobile không overflow ngang; không có page errors trong bộ test.

**Chưa thu mic vật lý trong kiểm thử tự động, chưa đo âm thanh ở đầu điện thoại
bên kia.** RTP RTT localhost ~0 ms không phải độ trễ thoại end-to-end.

Kết quả đã lưu, không phải lời mô tả dự kiến:

- `examples/call-web-demo/verification.json` — kết quả đã lưu trong source.
- `examples/call-web-demo/artifacts/browser-results.json` — raw measurement,
  ignored Git, có thể không còn ở session sau.
- `examples/call-web-demo/artifacts/demo-desktop.png`, `demo-tone.png`,
  `demo-echo.png`, `demo-virtual.png`, `demo-mobile.png` — screenshot ignored.
- `npm test` trong demo: **3 pass, 0 fail**, gồm một test WebRTC/ICE/DTLS/audio
  thật, không mock transport.
- TypeScript repo: `npx tsc --noEmit` pass.
- Test signaling: `bun test ./test/voiceCall.ts` từng pass 2 test offline.

## 4. Chạy lại demo

Tại lúc bàn giao, server đang lắng nghe `127.0.0.1:4317`, đã mở Chrome ở
`http://localhost:4317`. PID lúc kiểm tra là `6138`; **đừng dùng PID này để kill
ở session sau nếu chưa xác minh lại**.

Kiểm tra server trước, không khởi chạy trùng:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

Nếu cần cài/build lại:

```sh
cd /Users/tunv/zca-js
# Nếu root dependencies/dist chưa có:
npm ci --ignore-scripts
npm run build:esm

cd examples/call-web-demo
npm ci
npm run build
npm start
```

Mở **http://localhost:4317**. Trạng thái mặc định chưa mở mic và chưa login.

- Chọn **Thử hai chiều** + **Tone 440 Hz**, rồi **Bắt đầu thử âm thanh** để thử
  không cần quyền mic.
- Chuyển **Microphone** nếu người dùng muốn thử giọng thật, cho phép mic, dùng
  tai nghe tránh feedback.
- **Qua thiết bị ảo**: trên máy đã thử có Microsoft Teams Audio, chọn cùng
  thiết bị cho RX/TX để test loopback. Đây là chế độ thử riêng.
- **Kiểm tra helper IPC** chỉ start/query engine; không tự login/gọi điện.
- **Dừng** đóng audio session; **Dừng helper** đóng helper do demo tạo.

Kiểm thử (server phải chạy trước browser test):

```sh
cd /Users/tunv/zca-js/examples/call-web-demo
npm test
npm run test:browser
```

Chrome mặc định: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
có thể chỉ định `CHROME_PATH`. `DEMO_URL` đổi URL cho browser test. `PORT` đổi
port server; `ICE_SERVERS` nhận JSON ICE server list nhưng không tự mở public
service. `ZALO_CALL_EXECUTABLE` cho phép dùng helper bundle đã chép riêng.

**Quyền môi trường:** sandbox có thể chặn npm network, ICE/UDP, HAL enumeration,
GUI hoặc signal tới process ngoài sandbox. Dùng cơ chế escalation đúng của
client khi gặp blocker thật; không kết luận code hỏng từ kết quả sandbox đó.
Ví dụ đã quan sát: native `--list` trả `[]` trong sandbox, có thiết bị bên ngoài;
WebRTC test không kết nối trong sandbox nhưng pass ngoài sandbox.

## 5. Bản đồ source đã làm

### Thư viện chính

- `src/apis/voiceCall.ts`: `api.voiceCall.ring`, `answer`, `answerAck`, `cancel`,
  `end`; mã hóa/request/resolve dùng utils của session. Chỉ signaling.
- `src/apis/listen.ts`: phát event `call` cho `act_type: "voip"` trong control
  stream hiện tại (601), giữ action chưa biết, parse `data` nếu là JSON string.
- `src/models/CallEvent.ts`, `src/index.ts`: type exports.
- `src/apis.ts`: đăng ký factory.
- `test/voiceCall.ts`: payload và mã hóa offline.

### Demo

| File | Trách nhiệm |
| --- | --- |
| `server.mjs` | HTTP static + WebSocket RPC, session ownership, localhost/origin checks, native/media lifecycle |
| `media.mjs` | `RTCAudioSink`/`RTCAudioSource`, PCM queue, 10 ms pacing, bridge subprocess |
| `pcm.mjs` | Queue bounded, RMS, downmix/resample demo |
| `native/pcm-bridge.c` | CoreAudio virtual-only, stdin/stdout PCM16LE mono 48 kHz, rings/threads, stats stderr |
| `build-native.mjs` | Clang build thành `.runtime/pcm-bridge` |
| `helper.mjs` | Đọc IPC constant từ ASAR, private Unix sockets, AES/framing/ACK queue, start/init/devices/select/stop |
| `zalo-session.mjs` | Adapter opt-in QR login + control/signaling; **chưa xác minh Zalo thật** |
| `web/main.jsx`, `web/style.css` | Giao diện React, mic/tone/WebRTC, waveform, trạng thái, QR/experimental controls |
| `test/browser.mjs` | Chrome automation, ba đường audio + fake mic + helper + cleanup/mobile |
| `test/webrtc.test.mjs` | Audio qua hai WebRTC peers thật |
| `README.md` | Hướng dẫn dùng và giới hạn chi tiết |

Demo dependencies tách trong package riêng; không thêm React/WebRTC vào root
library. `.runtime/`, `dist/`, `artifacts/`, `node_modules/` của demo ignored.

## 6. Native IPC đã khôi phục

Tham số launch:

```text
ZaloCall <native-to-host-socket-path> <host-to-native-socket-path>
```

- Host tạo hai Unix servers và spawn helper.
- Helper gửi `{type:"update",command:"native-ready"}`.
- IPC transport: AES-128-CBC, IV zero, key là **constant đóng gói trong ASAR**,
  ciphertext hex, kết thúc `$`. Không hardcode hoặc log key trong repo.
- Host->native có ACK 3 byte từng frame; message dài chia chunk 4.000 ký tự hex
  với metadata `#id#count#index#$`. `helper.mjs` có queue và fragment handling;
  vẫn là implementation thử nghiệm, chưa fuzz/soak dài.
- Socket mặc định của app thật `/tmp/socketzalorecv2021`,
  `/tmp/socketzalosend2021`: **đừng dùng hai socket này trong demo**.

Các message quan sát được:

```js
// Init; xem helper.mjs và bằng chứng JS để điền đủ dữ liệu thật nếu cần.
{ type: "update", command: "init", data: {
  local: { id, avatar, name }, mainWindowId: id,
  osInfo, clientVersion, language, logPath, zrtcLogPath, dumpPath,
  ...deviceSettings, ...advancedSettings
} }

{ type: "request", command: "listDevice", data: null }
{ type: "update", command: "listDevice", data: {
  autoAudioInput: false, autoAudioOutput: false,
  defaultAudInputDevice, defaultAudOutputDevice, defaultVidDevice
} }
{ type: "request", command: "makeCall", data: {
  partner: [{ id, avatar, name }], type: 1 // audio 1:1
} }
{ type: "request", command: "endCall", data: null }
{ type: "control", data: voipControl }
{ type: "recvSignal", command: nativeSignalNumber, data: decodedHttpResult }
```

Native `sendSignal` -> HTTP dưới voice-call service:

| Signal | Action | Payload khác biệt quan trọng |
| --- | --- | --- |
| 401 | requestcall | calleeId, callId, codec mặc định `"[]"`, typeRequest từ native `type`, imei |
| 416 | request | calleeId, rtcpAddress, rtpAddress, codec, session, callId, imei |
| 407 | ringring | callerId, callId, status=0, imei |
| 402 | answer | callerId, callId, status, codec, rtcpAddress, rtpAddress, **session_id từ native session** |
| 408 | answerack | calleeId, callId, status=0, imei |
| 405 | cancel | **callerId từ native toId**, callId, callType, status=0, imei |
| 409 | endcall | **uidTo từ native toId**, callId, status=3, imei |
| 406 | logendcall | **call_id, partner_id, logdata**, status, duration, role, imei |

`extendData` có giá trị thì thêm `subCommand:3` ở request/answer. HTTP dùng
encrypted GET. Không tự suy ra enum answer status/callType. Adapter hiện dùng
web-session utils; common params và response shape tương thích desktop chưa
được chứng minh bằng cuộc gọi thật.

### Điểm chặn quan trọng: nhận cuộc gọi trên web

Đã kiểm tra ARM64 disassembly của `_parseRequest` (preferred address
`0x10001a888`): parser chỉ chấp nhận `hide`, `bye`, `makeCall`, `endCall`,
`listDevice`, rồi báo `Undefined request`.

**Không có lệnh IPC `request/answerCall` hay `acceptCall` đã xác minh.**
Có symbol native `ZCalleeWindow::btnAcceptClick`, `ZCallProcess::OnAnswerCall`
và `ZCallInfo::UiAnswerCallEvent`; chưa khôi phục đầy đủ call graph.
Nhận cuộc gọi hiện vẫn cần nút native trên Mac. HTTP `answer` là signaling của
engine, không thay thế được chuyển trạng thái/UI/media phía native.

## 7. Giới hạn hiện tại và lỗi đã xử lý

1. **Chưa có authenticated Zalo call nào được kiểm thử.** QR login adapter,
   engine init với user thật, ID mapping, response shape và remote audio còn
   cần xác minh.
2. Chỉ có một virtual device tương thích trên máy thử:
   `MSLoopbackDriverDevice_UID` (Microsoft Teams Audio). Nó đã chứng minh
   loopback local. **Không dùng một bus chung cho hai chiều cuộc gọi thật**,
   vì sẽ feedback. UI và backend chủ động chặn trường hợp đó.
3. Worker chỉ nhận **virtual Float32 mono 48 kHz**, rồi chuyển PCM16LE. Các
   cấu hình driver stereo/multichannel cần bổ sung chọn channel/downmix và
   kiểm tra format; không chỉ cài BlackHole rồi mặc định là chạy được.
4. Chưa có remote deployment, HTTPS/WSS/auth/TURN/multi-account/concurrent-call
   allocation hay thử server headless.
5. `@roamhq/wrtc` từng SIGSEGV ở teardown trên Node 24 và 22 dù audio test pass.
   Đã sửa: bỏ callback, stop sink/track/PC, thả reference wrapper, GC trong
   test/shutdown trước khi runtime thoát. Dùng scripts có `--expose-gc`.
   Đừng bỏ cleanup chỉ để làm test ngắn hơn; nếu tái phát, báo lỗi thật.
6. Chrome từng nhận RTP/decoded energy nhưng Web Audio analyser im lặng.
   Cách đã test pass: giữ **media element muted đang play** để tiêu thụ remote
   track, đồng thời nối **MediaStreamAudioSourceNode** riêng qua analyser/gain
   tới AudioContext destination. Chỉ MediaElementAudioSourceNode đã không
   giải quyết trường hợp này. Đừng xóa media element như code thừa.
7. PCM source dùng pacing theo thời gian monotonic, thay vì tin tuyệt đối
   `setInterval(10)`; tránh drift/tích lũy queue. Chưa có soak dài hoặc đo
   latency thoại ở thiết bị từ xa.
8. Không claim nghe được loa vật lý từ bài đo tự động; đã đo tín hiệu decoded
   tại browser và audio path ảo. Người dùng có thể thử mic/loa thật trên UI.

## 8. Việc AI session sau nên làm tiếp, theo thứ tự

### A. Khôi phục và kiểm tra baseline

- Đọc file này, kiểm tra `git status`, xem source hiện tại trước khi sửa.
- Kiểm tra server 4317; dùng lại nếu đúng demo hiện tại. Build/start nếu cần.
- Đọc `verification.json`, không gọi lại các trial native cũ chỉ để tìm lại
  điều đã có bằng chứng. Chạy check phù hợp khi code hoặc môi trường thay đổi.
- Hỏi người dùng muốn tiếp tục thử Zalo thật hay chỉnh demo nếu chưa có yêu
  cầu mới rõ ràng; có thể tiếp tục đọc/kiểm tra code không phụ thuộc câu trả lời.

### B. Chuẩn bị hai bus audio độc lập

- Kiểm kê driver/thiết bị hiện tại bằng `.runtime/pcm-bridge --list` với quyền
  HAL phù hợp; không mặc định còn đúng danh sách của session cũ.
- Chọn cách cung cấp RX/TX riêng. Nếu driver có stereo/multichannel, bổ sung
  mapping/channel conversion trong worker trước rồi kiểm chứng bằng tone.
- Nếu cần cài driver hoặc thay cấu hình hệ thống, trình bày thay đổi cụ thể và
  dùng approval cần thiết; session trước **chưa cài/cho phép driver cụ thể**.
- Kiểm thử hai bus thật tách nhau: phát vào TX không tự xuất hiện ở RX nếu chưa
  có đầu bên kia; không còn đường feedback.

### C. Thử Zalo thật với người dùng phối hợp

- Cần tài khoản/điện thoại thứ hai và người bên kia để xác nhận nghe/nói. Chưa
  có tài khoản thứ hai hay lịch thử nào được cung cấp.
- Cho người dùng chủ động login QR trong demo; không tự đọc cookie/key/token
  của app Zalo trên máy. Giữ credentials trong memory như thiết kế hiện tại.
- Đầu tiên thử outgoing audio qua `makeCall` tới **ID người dùng xác nhận**.
  Ghi chuỗi native state/signal, HTTP kết quả đã redacted, control thực tế.
- Xác minh desktop-helper init và `zca-js` web-session interoperability.
  Nếu thất bại, tìm chính xác ID/config/schema khác biệt; không giả trạng thái
  `connected` từ ACK hay HTTP 200.
- Chứng minh audio của người bên kia tới browser và mic browser tới điện
  thoại; sau đó thử đồng thời, end, gọi lại, mất mạng, reconnect.

### D. Giải quyết nút nhận cuộc gọi trên web

- Đây là công việc riêng chưa xong. Có thể nghiên cứu thêm native UI event /
  accessible action / control surface, nhưng phải xác minh trước khi thêm nút.
- Không gửi thử tên lệnh đoán mò `acceptCall` rồi coi HTTP answer là thành công.
- Có thể dùng nhận bằng native UI làm bước trung gian để chứng minh media,
  ghi rõ hạn chế đó; sau đó mới tìm phương án nhận hoàn toàn từ browser.
- Hướng hook C++ hiện bị permission blocker; không tự đổi signing/hardened
  runtime hoặc cài debugger để lách blocker của session trước.

### E. Sau khi end-to-end local pass

- Thử browser trên máy khác qua HTTPS/WSS + gateway auth + ICE/TURN phù hợp.
- Session ownership, cleanup, worker restart, bus allocation theo call/account.
- Soak/latency/echo, giới hạn tài nguyên, browser disconnect, credential lifecycle.
- Chỉ sau đó mới mô tả là giải pháp remote call hoàn chỉnh.

**Acceptance cuối:** browser mic -> remote phone nghe; remote phone nói ->
browser nghe; hai chiều đồng thời; end sạch; nhận/gọi được cuộc tiếp theo;
nhận từ web thực sự hoặc ghi rõ native UI còn bắt buộc.

## 9. Bằng chứng/tài liệu cũ để đào sâu khi cần

- `docs/reverse-engineering/zalo-call.md`: signaling và giới hạn ban đầu.
- `docs/reverse-engineering/zalo-call-evidence.json`: source snippets/ranges,
  hash của ASAR/module.
- `docs/reverse-engineering/zalo-call-trials.md`: trial native và lựa chọn hướng.
- `docs/reverse-engineering/zalo-call-trial-results.json`: kết quả sanitized.
- `scripts/trial-zalo-call.mjs`: harness IPC bounded 10 giây.
- `scripts/trial-audio-loopback.c`: tone/frequency loopback probe độc lập.
- `/tmp/zalo-call-analysis/`: source JS trích xuất, helper copy, symbol inventories
  và REA bundles; **file tạm, có thể đã mất**. Nếu cần, trích lại từ app hiện tại
  và kiểm tra hash, không suy ra app chưa cập nhật.

Hash khi đã phân tích:

```text
ASAR:      ebb10234e499eb9046663a26f4ee70e9c29f53e0a7f0a186117b307872b6b0b1
ZaloCall:  f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e
```

REA native inspection parent evidence:
`ev_d82ff3ce166ada811ba092a02439a06a51ff32e1da309f46535b3c156adf8059`.
Reference thuộc session cũ có thể không còn resolve; bundle export trước ở
`/tmp/zalo-call-analysis/native-trial-rea-evidence.json`.

Native PCM symbol candidates arm64 (preferred addresses, phải tính ASLR):
`RecordedDataIsAvailable` `0x10024f420`, `NeedMorePlayData` `0x10024fa80`.
Đây là bằng chứng tĩnh; chưa hook/stream được qua các symbol này.

REA đã báo integrity mismatch ở một số unpacked native binaries; đã dùng
record-and-continue để đọc và giữ giới hạn đó. Không có deep decompiler được
cấu hình trong session trước; không claim đã dịch ngược xong code native.

## 10. Trạng thái Git và nguyên tắc tiếp tục

Lúc bàn giao **chưa commit** các thay đổi của cả chuỗi công việc. Có modified
`src/apis.ts`, `src/apis/listen.ts`, `src/index.ts` và untracked docs/demo/scripts/
types/tests nêu trên. Không reset/clean hoặc ghi đè công việc này.

`scripts/buildAPI.js` dùng thứ tự `readdirSync` chưa sort. `npm run build` có
prebuild có thể làm reorder cả `src/apis.ts`, tạo diff rất lớn chỉ do thứ tự.
Session trước đã đưa thứ tự API cũ về và giữ ba dòng đăng ký `voiceCall`.
Khi chỉ cần compile thư viện, dùng `npm run build:esm` hoặc `npx tsc --noEmit`.
Nếu phải regenerate, xem diff và giữ thay đổi có chủ đích.

Người dùng ưu tiên làm việc thực tế, không hỏi xác nhận lặp lại cho bước đã
được cho phép. Tuy vậy không tự đặt cuộc gọi tới người chưa xác nhận, cài
driver hệ thống, thay signing hay công bố service ra Internet. Tiếp tục các
bước read-only/build/test phù hợp và báo rõ blocker thật.

Prompt ngắn để dùng ở session mới:

> Đọc `CALL_STREAM_HANDOFF.md` tại root repo. Tiếp tục từ baseline demo đã pass,
> ưu tiên hai bus audio riêng và kiểm chứng cuộc gọi Zalo thật. Không làm lại
> nghiên cứu từ đầu, không nhầm audio demo với authenticated Zalo call.

## 11. Outgoing checkpoint mới — 2026-10-22

Lỗi preflight đã được xác định và sửa. Backend từng báo
`servers[0].sent must be an int32`; đây là lỗi parser của repo, không phải relay
từ chối. Zalo PC 26.10.20.3253 hiện tại dùng native x86_64 SHA-256
`94ab8fa4afef21574933d6f5feb9e47fbf4da75f3b9ef1239ae587f1c1377990`.
`CallController::parseJsonServer` ở `0x1e2c10` đọc `rtpaddr`, `rtcpaddr` và
`relayTime` mặc định0; không đọc `sent/recv`. Repo đã sửa
`src/call/negotiation.ts` theo contract này và build lại `dist`.

Live trial sau sửa đạt: response401 status0, sáu relay candidate, candidate đầu
đăng ký thành công, codec/SRTP/SRTCP gates ready, state `relay-registered`.
Chưa có bằng chứng từ checkpoint đó rằng signal416 đã làm peer ringing.

UI cũng đã đổi: sau “Chuẩn bị gọi đi”, nút “Gọi bạn” tự chọn mode Zalo, xin
quyền microphone, mở browser WebRTC rồi gửi `/request`. Không còn bắt người dùng
tìm và bấm “Bắt đầu thử âm thanh” riêng. Sau khi rebuild UI, browser cũ phải
refresh; tải lại danh sách và chọn lại đúng peer. Không bấm preflight lần hai khi
outgoing state còn `relay-registered`, nếu không backend sẽ báo đang có call.

REA references cho lần kiểm tra này:

- ASAR parent: `ev_3d713437e159149057ce2eb786c5cf6b94709574ea9142bc002a66366f48891b`.
- Mach-O parent: `ev_eb0e9ccca7dab587c6a9b8bf2352390639168c7f8f2713b97e0bfdca1cdb0a91`.
- Export page có `parseJsonServer`: `ev_9e38a03729c116445661b313505eb0b929644764e2b25d9d62ef1f861b0fc8fe`.

Đọc phần “Live checkpoint” trong
`docs/reverse-engineering/zalo-call-connection-flow.vi.md` trước khi tiếp tục.
Việc tiếp theo là bấm `/request`, quan sát `request-accepted`, `ringring`,
`answer`, ACK/confirmed và bộ đếm RTP/SRTP thật; không làm lại phần preflight.
