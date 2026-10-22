# Nhật ký dịch ngược Zalo Call — 2026-10-21

> Tài liệu luồng tổng thể, event listener, `api.voiceCall` và cleanup khi kết thúc: [zalo-call-connection-flow.vi.md](zalo-call-connection-flow.vi.md).

## Mục tiêu và phạm vi

Ghi lại theo thứ tự các bước đã dùng trong phiên hôm nay để tìm hiểu luồng Zalo Call, sửa việc phân loại cuộc gọi thoại/video và khảo sát đường media video. Mục tiêu của repo vẫn là điều khiển cuộc gọi và đưa media qua ứng dụng web, không gọi engine Zalo Call để vận chuyển media.

Tài liệu này tách ba mức độ bằng chứng:

- **Quan sát được:** có trong log runtime đã làm sạch, source hoặc assembly đã lưu.
- **Suy luận:** kết luận hợp lý từ các quan sát nhưng chưa được xác nhận bằng một cuộc gọi hoàn chỉnh.
- **Chưa xác minh:** cần offer/call thật hoặc thông tin giao thức còn thiếu.

Không ghi cookie, token, IMEI, UID, call/session ID, IP, khóa SRTP hay thông tin đăng nhập. Artifact native được đối chiếu có SHA-256 `f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.

## Các bước đã thực hiện

### 1. Chốt câu hỏi cần trả lời

Vấn đề trước mắt là tại sao cuộc gọi thoại đến không hiện đúng trạng thái để nhận, đồng thời xác định phần nào của đường video có thể xây bằng RTP/RTCP và relay hiện có. Không coi việc parse được một offer hay gửi được packet là bằng chứng đã đàm thoại/video thành công.

### 2. Xác định binary và giới hạn công cụ

Đối chiếu binary native arm64 với assembly đã lưu tại `/tmp/zalo-call-analysis/helper-arm64-assembly.txt`; ghi hash để tránh nhầm phiên bản. Kiểm tra REA, Hopper và Ghidra: không có target binary đang mở cho REA, Hopper executable không có, Ghidra chưa cấu hình và Java không sẵn có. Vì vậy phiên này không cài thêm công cụ; dùng assembly arm64 có sẵn kết hợp với source/log trong repo. Kết quả phụ thuộc việc assembly đó khớp hash artifact nêu trên.

### 3. Lần theo nơi parse thông tin loại cuộc gọi

Trong assembly, lần tới `ZCallInfo::_parseActRequestDetail` tại `0x10001dfa0`. Request có dữ liệu JSON lồng nhau: `extendData.callType` và `params.video.enable` là hai tín hiệu riêng. Log runtime cho thấy một request có `callType: 0` trong khi `params.video.enable` khiến parser cũ đặt `videoRequested: true`.

Đối chiếu với lần người dùng gọi thử thoại, nguyên nhân phù hợp nhất là parser/UI ưu tiên tín hiệu video phụ thay vì loại cuộc gọi chính. Theo hợp đồng quan sát được trong phiên, `callType: 0` là thoại và `callType: 1` là video; đây là quy ước cần giữ có thể thay đổi nếu capture mới chứng minh ngược lại.

### 4. Sửa phân loại thoại/video và thêm chẩn đoán an toàn

Trong `src/call/negotiation.ts`, thay đổi thứ tự ưu tiên: nếu có `extendData.callType` thì dùng giá trị đó; chỉ suy ra từ `params.video.enable` khi `callType` vắng mặt. Giữ `videoEnable` và codec video dạng số thành các trường chẩn đoán riêng, không trộn chúng với loại cuộc gọi. Cập nhật demo và kiểm thử để bảo đảm `callType: 0` vẫn là thoại kể cả khi `video.enable` bật, đồng thời chấp nhận codec ID đơn hoặc danh sách.

Phần log/demo chỉ hiển thị các trường allowlist hữu ích cho chẩn đoán; không xuất identifier, địa chỉ mạng hay khóa. Đây là sửa lỗi phân loại, chưa chứng minh nhận cuộc gọi/media đã hoạt động hoàn chỉnh.

### 5. Lần theo đường video native và relay

Từ assembly đã lưu, xem `Peer::_initVideoRtpRtcp` tại `0x10019a4d4`, `onSendVideoRtp` tại `0x1001b4678`, và đường RTCP tại `0x1001b493c`. `Peer::getVideoSSRC()` trả về `CallController::getUserId()`; phần native khởi tạo SSRC video từ cùng giá trị này. Đây là quan sát về SSRC, không có nghĩa trạng thái sequence/crypto của audio và video dùng chung.

Đối chiếu framing relay trong source: loại 13/15 dành cho outbound video RTP/RTCP; loại 14/15 xuất hiện ở inbound video RTP/RTCP theo parser hiện có. P2P command 127 với command 8/9 là tín hiệu điều khiển liên quan trong ghi chú native trước đó. Các chi tiết framing và cách map này được lưu cùng bằng chứng ở [hợp đồng video ZRTC](zrtc-video-contract.md).

Assembly cũng có `Utility::videoCodecToStr` tại `0x100155a7c`; mapping codec được ghi trong hợp đồng video: 1=VP8, 2=VP9, 3=OPEN_H264, 4=H264, 5=H265. Không suy ra payload type RTP từ codec ID; payload type phải lấy từ offer/negotiation cụ thể.

### 6. Tạo primitive video độc lập trong source

Đã bổ sung đường gửi video vào relay registration bằng `sendVideo` và `sendVideoRtcp` (relay types 13/15). Thêm `src/call/videoRtpBridge.ts` làm cầu VP8 RTP tổng quát: nhận payload type và SSRC đã thương lượng cùng SRTP protect/unprotect được inject từ ngoài; dùng context riêng cho RTP; chỉ gửi/nhận sau khi được xác nhận; nhận packet thì giải bảo vệ và depacketize. Packetizer/depacketizer VP8 có giới hạn MTU và test frame phân mảnh.

Đây mới là primitive có thể tái sử dụng. Nó **chưa được nối vào `IndependentCall`**, chưa tự thương lượng key/payload type, chưa có capture/camera và chưa được bật để nhận cuộc gọi video. Giữ answer gate đóng cho video đến khi đủ dữ liệu.

### 7. Chạy kiểm tra và phân loại kết quả

Các kiểm tra đã chạy trong phiên:

- `bun run build`: thành công; Rollup báo external `node:dgram`/`node:net` như cấu hình hiện tại.
- `bun test ./test/rtpVp8.ts ./test/zrtcRelayMedia.ts`: 10 test pass, 37 assertions.
- `node --expose-gc --test test/independent-call.test.mjs test/call-notification.test.mjs`: 18 test pass.
- `npm run build` trong `examples/call-web-demo`: thành công.
- `git diff --check`: thành công.

Không tính `bun test ... ./test/zrtcRelay.ts` là pass: fixture UDP bị sandbox chặn với `bind EPERM 127.0.0.1`. Một lượt `npm test` rộng hơn có 24 pass và một lỗi WebRTC loopback ICE vẫn ở trạng thái `new` sau 11 giây; chưa xác định đó là lỗi code hay giới hạn môi trường. Vì vậy các kết quả này không được dùng làm bằng chứng cho kết nối media Zalo thật.

### 8. Kiểm tra trạng thái runtime và giới hạn xác nhận

Demo backend ở cổng 4318 đang chạy bằng module đã load trước các sửa đổi source/build. Không restart trong phiên để tránh làm rớt phiên Zalo đang đăng nhập và buộc quét QR lại. Log đã ghi nhận request/cancel; một mẫu có `callType: 0` nhưng parser cũ báo video. Một media summary trước đó có `relayAudio=34`, `srtpRejected=34`, `srtpAuthFailures=34`, nghĩa là các packet audio mẫu chưa xác thực được. Không có bằng chứng cuộc gọi video đã được nhận hay có media hai chiều.

Do đó, thay đổi phân loại giải quyết một lỗi logic có căn cứ, còn voice interop hiện tại vẫn cần kiểm chứng sau khi backend mới chạy. Video vẫn ở mức khảo sát và primitive.

## Việc còn thiếu trước khi bật video

1. Chạy backend từ source mới và đăng nhập lại nếu cần; trước khi thao tác xác nhận phiên có thể bị ngắt.
2. Thu một offer video đến thật, chỉ lưu snapshot allowlist: callType, `video.enable`, codec IDs, RTP/RTCP payload/profile/ptime và capability đã lọc.
3. Xác định chính xác video answer/capability JSON, RTP payload type, profile/packetization, SSRC/sequence expectations và cách derive key/crypto context cho video.
4. Xác nhận RTCP cần thiết (ví dụ PLI/FIR/NACK) và relay mapping bằng packet trace có kiểm soát.
5. Nối camera/WebCodecs vào packetizer/bridge; nối inbound bridge tới decoder và playback trên trình duyệt.
6. Chỉ mở answer gate sau khi có đủ negotiation/crypto; thử cuộc gọi video thật theo thứ tự nhận, gửi/nhận media, kết thúc, rồi thử lại voice để bảo đảm phân loại không hồi quy.

## Tệp liên quan trong repo

- [Hợp đồng video và trạng thái chưa xác minh](zrtc-video-contract.md)
- [Ghi chú negotiation](zrtc-negotiation-findings.md)
- [Hợp đồng capabilities](zrtc-capabilities-contract.md)
- [Bridge RTP video](../../src/call/videoRtpBridge.ts)
- [Parser/negotiation cuộc gọi](../../src/call/negotiation.ts)
- [Demo độc lập](../../examples/call-web-demo/)
- [Handoff tích lũy của luồng call](../../CALL_STREAM_HANDOFF.md)

## Kết luận phiên

Hôm nay đã xác định và sửa được xung đột giữa `callType` với cờ `video.enable`, đồng thời dựng primitive RTP/relay VP8 có test. Chưa xác nhận được cuộc gọi thoại hoạt động ổn định sau sửa và chưa có cuộc gọi video end-to-end. Bước kỹ thuật tiếp theo là chạy đúng backend mới, lấy offer video thật an toàn, hoàn thiện negotiation/crypto rồi mới đấu nối browser media.
