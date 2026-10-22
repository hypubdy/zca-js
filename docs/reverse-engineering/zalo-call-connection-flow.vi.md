# Luồng kết nối Zalo Call và API điều khiển — cập nhật 2026-10-22

Tài liệu mô tả luồng hiện có trong repo từ lúc nhận thông báo cuộc gọi tới khi gửi tín hiệu answer/end và dọn media. Đây là ghi chú cho implementation hiện tại; signaling HTTP không đồng nghĩa media đã kết nối. Trạng thái live voice/video vẫn phải được xác minh riêng.

## 1. Các lớp trong luồng

```text
Zalo event WebSocket (cmd 601)
        │ act_type=voip, act=request/answerack/cancel/endcall…
        ▼
api.listener ── emits "call" ──► ZaloSession / IndependentCall
                                      │ parse offer, trạng thái, relay
                                      ▼
                              WebSocket demo RPC/events
                                      │
                                      ▼
                              React UI + browser media

React RPC call-accept/call-end ──► demo server ──► api.voiceCall.answer/end
Browser mic/speaker ◄────────────► WebRTC audio bridge ◄──► RTP/SRTP relay
```

Control/signaling và media là hai đường riêng. `api.listener` nhận control; `api.voiceCall` gọi endpoint signaling; relay registration và RTP/SRTP xử lý media. Nhận event hoặc nhận HTTP response không chứng minh đã có âm thanh.

## 2. Luồng gọi đi được phục dựng từ Zalo PC

Bundle desktop `default-login-main-startup-shared-worker-znotification...js` cho thấy nút gọi gọi `makeCall(ids, isVideo, isGroup, ...)`. Với cuộc gọi 1:1, desktop chọn `type=1` cho audio và `type=3` cho video; group dùng `5`/`6`. Nó chuyển danh sách peer dạng `{id, avatar, name}` qua IPC `request / makeCall` tới helper native, sau khi kiểm tra network và IPC-call support. Cấu hình loại call này là bằng chứng cho Desktop 26.10.20, chưa phải enum API độc lập đã xác minh cho mọi phiên bản.

Chuỗi caller one-to-one audio được phục dựng như sau:

1. **Desktop UI → native helper:** `makeCall` gửi `{ partner: [{id, avatar, name}], type: 1 }`. Native `ZCallProcess::OnReceiveCmdMakeCall` kiểm tra quyền/đang có call và chuyển sang `ZCallInfo::receiveRequestMakeCall`.
2. **Preflight signaling 401:** native phát signal 401; renderer map sang encrypted `GET /api/voicecall/requestcall` với `{calleeId, callId, codec: "[]" nếu vắng, typeRequest, imei}`. Response quay lại helper dưới `recvSignal, command: 401`.
3. **Tạo caller session:** `ZCallInfo::receiveRequestCallResponse` kiểm tra response, call ID trùng, call đang ở trạng thái dialing và chưa xử lý response lặp. Response lỗi đi nhánh kết thúc/toast; response thành công được đưa qua `_prepareCallConfig` rồi `PeerWrapper::makeCall`.
4. **Khởi động media và relay phía caller:** `Peer::makeCall` khởi tạo config với caller flag, chọn audio codec/profile, khởi động audio/Peer và ZRTC config. Khi relay init thành công, callback `ZCallInfo::onInitZrtpWithServer` gọi `_requestCallZrtp`.
5. **Gửi media offer 416:** renderer map signal 416 sang encrypted `GET /api/voicecall/request` với `{calleeId, rtcpAddress, rtpAddress, codec, session, callId, imei}`; nếu có capability thì thêm `extendData` và `subCommand: 3`. Đây là bước phát request/offer đến phía callee sau khi caller đã có session/relay state.
6. **Remote ringing/answer:** callee nhận control `request` và có thể gửi `ringring`; khi callee answer, server phát answer response/control. Caller vẫn phải theo dõi answer và ACK phù hợp trước khi coi call đã confirmed. Audio cần RTP/SRTP hợp lệ và hai chiều; HTTP 401/416 thành công chỉ chứng minh signaling từng bước.
7. **Kết thúc:** caller gửi cancel khi đang thiết lập hoặc endcall khi đang call, rồi đóng socket/media và dọn state. Các action cụ thể vẫn phải gắn với trạng thái hiện tại; không gửi endcall với call ID giả.

Các bằng chứng tĩnh native chính: `ZCallProcess::OnReceiveCmdMakeCall` (`0x1000ce9fc`), `ZCallInfo::receiveRequestMakeCall` (`0x1000c05c8`), `ZCallProcess::OnReceiveRequestCallResponse` (`0x1000cfb44`), `ZCallInfo::receiveRequestCallResponse` (`0x1000cb46c`), `ZCallInfo::_prepareCallConfig(response)` (`0x1000cb98c`), `Peer::makeCall` (`0x1001a4b48`) và `ZCallInfo::onInitZrtpWithServer` (`0x1000c6960`). Các địa chỉ là preferred arm64 addresses của artifact đã ghi trong [zalo-call-evidence.json](zalo-call-evidence.json) và [ghi chú negotiation](zrtc-negotiation-findings.md), không phải runtime addresses sau ASLR.

### API signaling gọi đi trong repo

Bundle có hai endpoint gọi đi mà public wrapper hiện tại **chưa expose**:

| Desktop signal | Endpoint | Payload quan sát được |
| --- | --- | --- |
| 401 | `/api/voicecall/requestcall` | `calleeId`, `callId`, `codec` (default `"[]"`), `typeRequest`, `imei` |
| 416 | `/api/voicecall/request` | `calleeId`, `rtcpAddress`, `rtpAddress`, `codec`, `session`, `callId`, `imei`; optional `extendData`, `subCommand: 3` |

`src/apis/voiceCall.ts` expose `requestCall` cho `/requestcall` và `request` cho `/request`, cùng các method `ring`, `answer`, `answerAck`, `cancel`, `end`. `request` yêu cầu caller engine truyền đầy đủ media/session đã thương lượng; wrapper chỉ mã hóa payload, không tự tạo relay, codec, session hay capability.

**Trạng thái demo:** UI tải tối đa 200 bạn bè (server chỉ gửi `id` và tên), rồi có hai thao tác: “Chuẩn bị gọi đi” gửi `/requestcall`, dựng ZRTC/Opus/SRTP và đăng ký tối đa tám relay candidate (caller11/subcommand2); “Gọi bạn” tự chọn mode Zalo, xin quyền mic, mở WebRTC và phát signal416 qua `/request`. Native `fromId/toId`, session, khóa và IP relay chỉ ở backend; UI chỉ giữ ID người bạn đã chọn và summary đã lọc. `/request` và answer/ACK plumbing đã được nối nhưng capability JSON là candidate tái tạo tĩnh, chưa được peer xác nhận live; UI chỉ coi audio TX mở sau answer status0, codec/SRTP checks và local `answerack` response.

### Live checkpoint: preflight và caller relay — 2026-10-22

Một lần thử thật đã đi qua preflight và caller relay với kết quả đã lọc sau:

```text
/requestcall accepted
status: 0
relay candidates: 6
selected candidate: 1
caller relay: registered
codec: ready
SRTP RTP: ready
SRTCP gate: ready
outgoing state: relay-registered
```

Kết quả này chứng minh response401 đã parse được và gói init caller đã được relay chấp nhận. Nó chưa chứng minh callee đổ chuông: signal416 `/request` chưa được gửi ở checkpoint này.

Lỗi trước checkpoint là `servers[0].sent must be an int32`. Parser trong repo đã yêu cầu `sent/recv`, nhưng native hiện tại không dùng hai field này. Đối chiếu đúng Zalo PC `26.10.20.3253`, native x86_64 SHA-256 `94ab8fa4afef21574933d6f5feb9e47fbf4da75f3b9ef1239ae587f1c1377990`, cho thấy export `zrtc::CallController::parseJsonServer` tại `0x1e2c10`. Disassembly của hàm đọc:

1. `rtpaddr` bằng `CallUtility::jsonGetString`;
2. `rtcpaddr` bằng `CallUtility::jsonGetString`;
3. `relayTime` bằng `CallUtility::jsonGetInt(..., 0)`;
4. parse hai địa chỉ theo dấu `:` rồi thêm `ZRTPServerInfo`.

`sent` và `recv` có thể xuất hiện như metadata từ service nhưng không thuộc contract dựng server của hàm native này. `parseZrtcOutgoingPreflight()` vì vậy giữ `rtpAddress`, `rtcpAddress`, `relayTime` và bỏ qua `sent/recv`. Không nới lỏng kiểm tra địa chỉ, session, call ID hoặc `zrtc_config`.

Bằng chứng REA cho đúng artifact hiện tại:

- ASAR SHA-256 `ebb10234e499eb9046663a26f4ee70e9c29f53e0a7f0a186117b307872b6b0b1`; application analysis parent Evidence `ev_3d713437e159149057ce2eb786c5cf6b94709574ea9142bc002a66366f48891b`. Coverage JavaScript là partial và integrity policy là record-and-continue.
- Native Mach-O inspection parent Evidence `ev_eb0e9ccca7dab587c6a9b8bf2352390639168c7f8f2713b97e0bfdca1cdb0a91`; export page chứa `parseJsonServer` là `ev_9e38a03729c116445661b313505eb0b929644764e2b25d9d62ef1f861b0fc8fe`.
- REA xác nhận identity/export/address; mô tả field đọc trong hàm được đối chiếu bằng disassembly `otool` vì session chưa có Ghidra/Hopper/Rizin deep provider. Đây là bằng chứng tĩnh, không phải quan sát runtime của Zalo PC.

Luồng UI sau bản sửa:

```text
Tải bạn bè
  → chọn peer
  → Chuẩn bị gọi đi
      → requestcall-start
      → response-parsed
      → registration-start
      → candidate-start
      → candidate-registered
      → caller-relay-ready
  → Gọi bạn
      → trình duyệt xin quyền microphone
      → media-offer mode=zalo/input=mic
      → request-start
      → request-accepted
      → chờ ringing → answer → answerack/confirmed
```

Nút “Gọi bạn” không còn yêu cầu người dùng mở audio ở một panel khác trước. Nó chỉ mở khi đã chọn peer, danh sách bạn đã tải, caller relay còn đăng ký và state là `relay-registered`. Khi bấm, nút tự chuẩn bị audio Zalo/mic rồi mới gửi `/request`. Nếu đã có một phiên audio khác đang active, cần kết thúc phiên đó để tránh thay track hoặc gửi offer sai call.

Chẩn đoán theo event:

| Event/stage cuối | Ý nghĩa | Việc kiểm tra tiếp |
| --- | --- | --- |
| `requestcall` error | HTTP/session preflight lỗi | trạng thái login, voice-call domain, encrypted request |
| `parse-or-validate` | Response401 không khớp contract | chỉ log type/field allowlist; đối chiếu native parser hiện tại |
| `candidate-registration` | UDP init caller thất bại | thử candidate kế tiếp; kiểm tra init11/subcommand2 và response token/status |
| `caller-relay-ready` | Caller relay/codec/SRTP đã chuẩn bị | mở mic WebRTC rồi gửi `/request` |
| `request-accepted` | HTTP416 được service nhận | chờ control `ringring`/`answer`; chưa gọi là connected |
| `answer-received` | Peer đã answer | validate codec/capability, tạo RX/TX contexts, gửi answer ACK |
| `confirmed` | Signaling và media gate đã xác nhận | kiểm tra bộ đếm RTP/SRTP hai chiều và âm thanh thật |

Log chẩn đoán không được chứa `sessId`, SRTP key, token, cookie, relay IP đầy đủ hoặc ID người dùng. Snapshot UI chỉ hiển thị số candidate, phase, trạng thái codec/security và lỗi đã lọc.

**Giới hạn còn lại:** caller offer builder dùng codec mặc định Opus 16 kHz/mono và conservative capability candidate sinh từ `zrtc_config`; tối thiểu capability được peer chấp nhận chưa xác minh. Cần chạy live trial bằng nút `/request`, kiểm tra callee ringing, answer status và ACK, sau đó chứng minh RTP/SRTP TX/RX thật từ browser. Unit test chỉ chứng minh state transitions và packet plumbing với fixture giả; không chứng minh Zalo chấp nhận offer. Không được diễn giải response `/request` thành công thành cuộc gọi voice đã kết nối.

## 3. Kết nối luồng event và nhận thông báo cuộc gọi

Sau khi đăng nhập, khởi động listener và đăng ký event trước hoặc ngay sau `start()`:

```ts
const api = await zalo.loginQR(/* ... */);

api.listener.on("call", event => {
  if (event.act_type !== "voip") return;
  if (event.act === "request") {
    // Incoming one-to-one call: inspect event.data before using identifiers.
  }
  // Handle answer ACK and terminal events separately.
});

api.listener.on("connected", () => { /* event stream is online */ });
api.listener.on("disconnected", (code, reason) => { /* no new call events */ });
api.listener.start();
```

Trong implementation, `src/apis/listen.ts` xử lý WebSocket message `version=1, cmd=601, subCmd=0`, giải mã `data.controls`, phát `call_control_batch` dạng summary an toàn rồi phát từng control `act_type === "voip"` thành event `call`. `data` dạng JSON string được parse thành object. Event giữ nguyên `act` chưa biết để caller không phải dựa vào enum chưa xác minh.

Các action thường gặp trong adapter hiện tại:

- `request`: lời mời one-to-one; `IndependentCall.observe()` parse offer và giữ một cuộc gọi pending.
- `answerack` / `answer_ack` / `answer-ack`: chỉ đánh dấu peer confirmed khi call ID trùng với pending call và answer đã gửi/đang gửi.
- `cancel`, `endcall`, `end_call`, `end`, và biến thể group: xóa pending state, đóng relay/media phía ứng dụng.
- `group_request`: được ghi nhận/forward như control nhưng group call chưa được triển khai trong luồng independent này.

Không nên log toàn bộ `event.data` trong ứng dụng thật. Dùng allowlist chẩn đoán; payload có thể chứa identifier, session hoặc thông tin media nhạy cảm.

## 4. `api.voiceCall`: signaling one-to-one

`api.voiceCall` được khởi tạo trong `src/apis.ts`; các method mã hóa JSON params bằng session AES rồi gọi GET tới `/api/voicecall/<action>` trên `zpwServiceMap.voice_call[0]`. API yêu cầu session đăng nhập hợp lệ.

| Method | Action HTTP | Vai trò |
| --- | --- | --- |
| `ring(callerId, callId)` | `ringring` | Acknowledge/ring control cho incoming request; không nhận cuộc gọi và không mở mic. |
| `answer(payload)` | `answer` | Gửi signaling answer với status và tham số media/negotiation. |
| `answerAck(calleeId, callId)` | `answerack` | Gửi ACK signaling; không tự xác nhận đã có media. |
| `cancel(callerId, callId, callType)` | `cancel` | Gửi cancel theo schema hiện có; không được xem là API reject incoming đã xác minh. |
| `end(uidTo, callId)` | `endcall` | Gửi tín hiệu kết thúc call (`status: 3`). |

`answer()` nhận `AnswerCallPayload`: `callerId`, `callId`, `status`, tùy chọn `codec`, `rtcpAddress`, `rtpAddress`, `session_id`, `extendData`. Khi có `extendData`, implementation thêm `subCommand: 3`. Giá trị status/codec/transport phải lấy từ luồng tương thích đã thương lượng; không đặt giá trị đoán mò. `ring()` chỉ là signaling phụ, không thay thế `answer()`.

Ví dụ nhận và kết thúc ở tầng thư viện:

```ts
api.listener.on("call", async event => {
  if (event.act_type !== "voip" || event.act !== "request") return;

  // Parse/validate the actual request schema first. Do not assume every
  // server version uses the same callerId/callId field names.
  const offer = parseZrtcIncomingOffer(event.data);

  // Only after constructing a supported answer from negotiated media state:
  // await api.voiceCall.answer(answerPayload);
  // Wait for a matching answer ACK before opening media send gates.

  // At hangup, use the peer ID and call ID belonging to this active call:
  // await api.voiceCall.end(peerId, String(offer.callId));
});
api.listener.start();
```

Trong demo, `ZaloSession.answerIndependent(payload)` gọi `api.voiceCall.answer`; kết quả chỉ được báo là response đã nhận, `peerConfirmed: false`. `IndependentCall.observe()` mới đổi sang `confirmed` khi thấy ACK phù hợp. `answerTrialAvailable` còn có gate cho relay/codec/SRTP và hiện chỉ cho audio trial có điều kiện; video answer chưa mở.

## 5. Luồng demo: từ incoming request tới answer trial

1. UI gọi `zalo-login`; backend đăng nhập và `ZaloSession.attachApi()` đăng ký listener `call`.
2. Khi có `request`, backend gọi `independent.observe(event)`. Parser đọc offer, phát `independent-offer` chỉ với trường an toàn và lưu pending call tạm thời.
3. Server tự thử `independent.registerRelay()` nếu offer parse được. Việc relay đăng ký thành công chỉ có nghĩa control/relay setup đi được; chưa có peer-confirmed media.
4. UI nhận WebSocket event `independent-offer`/`independent-state`; người dùng cần chuẩn bị audio session browser ở mode `zalo`. Mic yêu cầu quyền trình duyệt.
5. UI gửi RPC `call-accept`. Server kiểm tra Zalo online, browser owner và media mode; dựng answer từ state được chọn; đánh dấu answer đang gửi rồi gọi `ZaloSession.answerIndependent()` → `api.voiceCall.answer()`.
6. Khi HTTP response về, UI chỉ hiển thị “đang chờ caller ACK”; RTP mic vẫn bị khóa. ACK khớp call ID mới đặt `confirmed`, nhưng media cần thêm codec/SRTP/relay thành công.

Luồng này không có RPC `call-reject` được triển khai. Đừng dùng `cancel()` thay reject incoming nếu chưa xác minh server semantics. Có thể xử lý remote `cancel/endcall` event và dọn local session; khả năng từ chối chủ động cần một API/action được xác minh riêng.

## 6. Nghe và nói trong browser là đường media khác

`api.listener` chỉ nghe **sự kiện cuộc gọi**, không nhận âm thanh. `api.voiceCall.answer()` chỉ gửi **signaling**, không tự mở loa/mic. Âm thanh browser cần chuỗi riêng:

```text
microphone → WebRTC capture/PCM → Opus encode → RTP → SRTP → relay
relay → SRTP authenticate/decrypt → RTP/Opus decode → browser audio source → speaker
```

Trong demo, `media-offer` tạo `MediaSession`/WebRTC cho browser; mode `zalo` chỉ được phép khi `IndependentCall.status().browserBridgeAvailable` true. Browser microphone đi qua `independent.sendBrowserPcm()`; chiều nhận đưa PCM đã giải mã vào `media.pushPcm()`. Đây là bridge audio thử nghiệm và có answer/crypto gates; test unit hoặc HTTP response không chứng minh interop live. Video bridge hiện là primitive RTP VP8 riêng, chưa nối vào call lifecycle/browser camera/decoder.

## 7. Kết thúc call và dọn tài nguyên

### Qua demo web

UI gọi RPC `call-end`. Server:

1. `stopMedia()` đóng local WebRTC/media và gỡ callback PCM.
2. Lấy active call từ `independent.activeCall()`.
3. Nếu còn active call và Zalo online, gọi `zalo.endCall(peerId, callId)` → `api.voiceCall.end(peerId, callId)` → action `endcall`.
4. Gọi `independent.clear(true)` để đóng relay, encoder, SRTP/SRTCP context, timer và xóa pending/confirmed state.

Nếu không còn call active hoặc Zalo offline, backend vẫn dừng audio cục bộ và dọn independent state; khi offline không thể gửi end signaling. Event terminal từ remote cũng gọi cleanup.

### Qua thư viện

Với call đang hoạt động, gọi:

```ts
await api.voiceCall.end(peerId, String(callId));
```

Ứng dụng tích hợp tự phải dừng capture/playback, đóng socket/relay, hủy timer, xóa khóa/context media và bỏ pending state. Method thư viện chỉ gửi signaling; nó không quản lý browser media lifecycle.

## 8. API/action hiện có và chưa có

- **Nghe incoming call event:** `api.listener.on("call", handler)` + `api.listener.start()`.
- **Acknowledge/ring:** `api.voiceCall.ring(callerId, callId)`.
- **Answer signaling:** `api.voiceCall.answer(payload)`; negotiation phải hợp lệ.
- **Peer answer ACK:** được quan sát qua event listener; `answerAck()` là method gửi ACK từ phía local, không phải cách chờ ACK.
- **Kết thúc signaling:** `api.voiceCall.end(peerId, callId)`.
- **Cancel:** `api.voiceCall.cancel(...)`; semantics không đủ để kết luận đây là reject incoming.
- **Khởi tạo outgoing:** API có wrapper cho cả `requestcall` và `/request`; RPC/UI parse 401, thử caller relay, chuẩn bị candidate codec/SRTP, rồi chỉ gửi 416 qua action UI riêng khi browser mic/audio session sẵn sàng. Answer parse/408 ACK đã nối; live peer acceptance và duplex voice chưa xác minh.
- **Reject incoming trong demo:** chưa có RPC/API đã xác minh.
- **Nhận/phát tiếng:** không nằm trong `voiceCall`; cần media engine/bridge RTP-SRTP và browser audio.
- **Video call end-to-end:** chưa được nối/bật trong lifecycle hiện tại.

## 9. Tệp source để lần theo

- `src/apis/listen.ts`: giải mã cmd 601, phát event `call`.
- `src/models/CallEvent.ts`: kiểu event và batch summary.
- `src/apis/voiceCall.ts`: signaling methods, endpoint và payload.
- `examples/call-web-demo/zalo-session.mjs`: login, listener, answer/end wrapper.
- `examples/call-web-demo/independent-call.mjs`: parse offer, trạng thái pending/confirmed, relay và cleanup.
- `examples/call-web-demo/server.mjs`: RPC `call-accept`, `call-end`, `media-offer`, `media-stop`.
- `examples/call-web-demo/web/main.jsx`: UI nhận event, chuẩn bị browser media, answer và hangup.
- [Nhật ký dịch ngược phiên hôm nay](zalo-call-re-session-2026-10-21.vi.md)
- [Hợp đồng video ZRTC](zrtc-video-contract.md)

