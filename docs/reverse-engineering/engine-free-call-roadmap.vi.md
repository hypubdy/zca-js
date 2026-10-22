# Lộ trình bỏ ZaloCall nhưng vẫn gọi thoại

Cập nhật 2026-10-21. Mục tiêu là browser React nhận/kết thúc cuộc gọi, phát tiếng
loa và gửi mic qua một backend độc lập. Backend không khởi chạy hay gọi vào
`ZaloCall`. Đây là kế hoạch triển khai dựa trên source `zca-js` và disassembly
ARM64 của `ZaloCall` 26.10.20, SHA-256
`f1ac81228f235e92d480dfe4619d568b0a84a5abd70fc73256dcab5f73aa3f3e`.

**Trạng thái hiện tại:** signaling parser, relay envelope, Opus PCM gateway,
RTP/SRTP, RTCP report/parser, SRTCP/type5 adapter path và cầu audio WebRTC ↔ PCM
đã có. Answer body builder dùng relay đã chọn và capabilities do caller truyền
vào cũng đã có. Một incoming offer thật đã được parse và đăng ký relay UDP
persistent thành công (Opus 48k stereo, SRTP profile1, SRTCP clear). Demo nay có
nút answer trial thủ công gửi 402/status0 với capability candidate bảo thủ; nó
chưa được gửi trên cuộc gọi thật. Chưa quan sát peer ACK hay tiếng nói. Tone/echo,
UDP localhost và primitive tests không chứng minh interop với Zalo.

Mục tiêu triển khai là hoàn tất đàm thoại hai chiều ngay trên giao diện web,
không dựa vào ZaloCall. Backend hiện có bộ đếm RX hiển thị trên trang (relay,
SRTP, Opus, giao cho WebRTC) để lần thử thật xác định được điểm dừng; ACK đến
trong khi HTTP answer còn chờ cũng được giữ lại. Đây là cải thiện khả năng thử
và chẩn đoán, chưa phải bằng chứng đàm thoại hoạt động.

Các lần gọi thật gần nhất đều có answer ACK khớp và WebRTC connected. Lần đầu
relay RX audio/RTCP đều bằng0. Lần sau backend có mic PCM và gửi 765 gói RTP
không lỗi cục bộ; relay trả 13 gói audio nhưng SRTP từ chối cả13, không gói nào
decode/playout, RTCP cũng bằng0. Vì vậy hiện đã thấy luồng relay về, nhưng chưa
thể xác thực media; cần tách key/profile khỏi replay/index và kiểm tra media
đầu gửi. Cảnh báo mạng lag là phù hợp với trạng thái này. Bản hiện tại ghi offer
ở dạng đã lọc và phân loại riêng lỗi SRTP auth/replay để lần thử tới thu hẹp
nguyên nhân.

## Các bước theo thứ tự phụ thuộc

1. **Giữ signaling làm mặt điều khiển.** Khi listener phát cuộc gọi đến, giữ
   call ID và hai user ID đúng theo request; phân biệt ringing, accepted,
   connecting, confirmed, cancelled và ended. `answer`/`answer_ack` chỉ đổi
   trạng thái điều khiển, không tự mang âm thanh. Không báo “đã nhận” chỉ vì
   HTTP answer trả thành công.

2. **Đọc offer và tự công bố đúng capability.** Parse codec, payload, sample
   rate, channel, packet time, relay candidates và các cờ crypto. Sinh
   `extendData` từ những tính năng backend thật sự hỗ trợ. Native so sánh
   `packetMode`, `gccMode`, `srtpMode`, `srtcp`, `sP2P` với cấu hình của nó;
   mismatch có thể tắt nhánh tương ứng. Chưa tìm được JSON tối thiểu nào được
   server/peer xác nhận là chấp nhận, nên phải kiểm chứng với một incoming call
   phối hợp. Bắt đầu với voice + relay UDP; tắt quảng cáo P2P, video, TCP, FEC
   hoặc GCC nếu chưa triển khai.

3. **Đăng ký relay và giữ đúng socket suốt cuộc gọi.** Incoming callee dùng
   request command 12; caller dùng 11. Subcommand 2 dùng trước khi confirmed,
   1 khi controller đã confirmed. Chỉ dùng relay trả success từ đúng địa chỉ
   và transport đã chọn; giữ token theo từng relay. Native ping session mỗi
   6000 ms trên cùng transport. Trong repo đã có `ZrtpRelaySession`: giữ socket,
   retry init theo tick 1000 ms với giới hạn implementation rõ ràng, parse gói
   đến và gửi relay-end. Hiện mới chọn một endpoint literal; chưa chọn nhiều
   candidate/TCP hay xác nhận server chấp nhận independent client. Bản demo tự
   bắt đầu đăng ký ngay khi có offer; nút relay chỉ còn dùng để thử lại khi tự
   đăng ký thất bại.

4. **Tạo và mã hóa RTP độc lập.** Đã thêm Opus WASM encoder/decoder cho đúng
   hai format native đã thấy (16 kHz mono và 48 kHz stereo), cùng bộ đổi PCM
   streaming 48 kHz mono sang định dạng codec và đã nối PCM WebRTC vào codec.
   Còn cần xác minh pacing/timestamp trên một relay đã được peer chấp nhận.
   Native gắn local
   call user ID làm SSRC; sequence mặc định ngẫu nhiên 1..32767 nếu không set
   rõ. Native có PT112/16 kHz mono và PT113/48 kHz stereo. Có khác biệt cần
   giải quyết trước khi forward Opus nguyên gói: static native getter trả clock
   theo cấu hình encoder (có thể 16 kHz), trong khi RTP/Opus chuẩn dùng clock
   48 kHz cho mọi mode ([RFC 7587](https://www.rfc-editor.org/rfc/rfc7587)).
   Vì vậy bước đầu nên decode/encode qua PCM và xác minh timestamp bằng packet
   trace, không copy browser RTP timestamps.

5. **Làm đúng crypto rồi mới bọc relay.** Mã hóa/xác thực SRTP trên RTP body
   trước khi thêm envelope; khi nhận thì kiểm tra nguồn, mở envelope, xác thực
   và unprotect trước khi decode. RTP hiện hỗ trợ profile 1/2. SRTCP contexts đã
   nối với relay type5 khi hai cờ khớp và có synthetic round-trip test; chưa có
   native-derived vector/runtime peer test.
   Profile 3 và `srtpNoSeq` chưa đủ. Nếu offer cần một nhánh chưa hỗ trợ,
   không answer với giả định plaintext hoặc tự đổi mode. RTCP có policy và
   index riêng; SRTP RTP pass chưa chứng minh SRTCP hoạt động ([RFC 3711](https://www.rfc-editor.org/rfc/rfc3711)).

6. **Chuyển luồng qua browser hai chiều.** Đã nối browser WebRTC microphone qua
   `RTCAudioSink` → PCM 48 kHz mono → Opus → RTP/SRTP → relay; RX đi ngược lại
   qua authenticate/decrypt → Opus decode → PCM queue → `RTCAudioSource` → loa
   trình duyệt. Mic vẫn bị gate tới khi `confirmed`. RX relay: type 4 audio, type 5
   RTCP; TX client: type 3 audio, type 5 RTCP, token little-endian. Type 127
   command 6/7 là nhánh P2P, không phải relay mặc định. Parser RTP đã hỗ trợ
   extension/CSRC; RTCP parser và reception stats hiện tạo được SR/RR report
   block. Còn thiếu negotiated report scheduler, bounded jitter buffer và
   interop-validated loss behavior.
   Browser WebRTC có ICE/DTLS/SRTP riêng; không dùng khóa Zalo cho leg browser.
   Giao diện hiển thị counter mic PCM, mẫu bị giữ trước ACK, Opus/RTP gửi, lỗi
   gửi, relay RX, SRTP thành công/từ chối, Opus decode và số gói đã giao cho loa
   WebRTC. Chênh lệch các counter giúp phân loại lỗi tại relay, RTP/SSRC, crypto,
   codec hoặc WebRTC playback; counter không chứa packet, khóa hay audio.

7. **Answer chỉ bằng thao tác tường minh.** Demo có answer trial sau khi offer,
   relay, codec, SRTP và browser mic/loa sẵn sàng. Candidate `extendData` chỉ
   quảng cáo relay UDP, SRTP profile1, clear RTCP và tắt P2P/GCC chưa hỗ trợ.
   Chờ `answer_ack` khớp call ID trước khi mở mic RTP; ghi riêng “HTTP accepted”,
   “peer confirmed” và “first authenticated media”. Candidate và ACK shape còn
   cần thử trên cuộc gọi thật.

8. **Kết thúc đồng bộ và dọn toàn bộ session.** Khi browser bấm kết thúc, chặn
   mic ngay, gửi end signaling phù hợp, gửi relay end khi token/socket còn,
   dừng keepalive, đóng socket, hủy jitter/crypto state và release browser
   tracks. Thứ tự chính xác giữa HTTP end và UDP relay end chưa được xác định
   đầy đủ; local audio phải dừng ngay, không chờ ACK vô hạn. Xử lý tương tự khi
   remote end, cancel, mất listener hoặc timeout; lần gọi tiếp phải có sequence,
   SRTP rollover/replay state và key context mới.

## Cổng kiểm thử trước khi tuyên bố hoàn thành

- Offline: byte fixtures đúng chiều TX/RX; sai token/source/length bị loại;
  SRTP authentication/replay/ROC; SRTCP; codec và timestamp; cleanup khi cancel.
- Tích hợp backend: relay socket persistent, registration thật trên incoming
  do người dùng phối hợp, response từ endpoint đúng, keepalive, nhận datagram
  SRTP có xác thực. Chỉ ghi counter và trạng thái đã redacted.
- E2E: người ở đầu kia nghe được mic browser; browser nghe được giọng đầu kia;
  hai chiều đồng thời; hai bên đều kết thúc được; nhận cuộc kế tiếp sạch. Lặp
  lại sau reconnect. Chỉ các bước cuối mới chứng minh gọi được thật.

## Những gì đã có và phần còn là blocker

Đã có parser negotiation, accepted-402 body builder và manual answer trial,
Zalo envelope codec, persistent UDP registration, SRTP RTP profile 1/2,
synthetic SRTCP/type5 relay path, RTCP report/parser/reception stats, RTP
parser/sender, Opus WASM/PCM conversion và cầu audio browser hai chiều. Một
incoming offer/relay registration thật đã pass. Build và offline tests pass;
build và offline tests pass. Live RX media đã được xác nhận như checkpoint bên
dưới; uplink mic tới peer vẫn cần kiểm chứng.

### Thử nghiệm live 2026-10-21 (15:39 UTC+7)

Người dùng xác nhận vừa gọi được qua giao diện web. Log live của lần gọi cho
thấy relay media được SRTP xác thực, Opus decode thành công và PCM được giao
cho browser audio source (`playedInBrowser: true`); bộ đếm tăng từ 1,450 lên
2,250 gói decode trong khoảng 16 giây, tương đương luồng đều khoảng 50 gói/s.
Cuộc gọi kết thúc bằng `end_call` lúc 15:39:20. Đây là bằng chứng runtime đầu
tiên cho đường RX relay → SRTP → Opus → browser; trước đó 13 gói RX đều bị
SRTP từ chối.

Leg mic WebRTC có mẫu PCM và RMS khác 0 trong phiên (`inputRms: 0.0355` lúc
kết thúc), nhưng tiến trình demo đang chạy chưa giữ bộ đếm cuối phiên nên log
này chưa xác nhận được gói RTP/SRTP uplink đã tới relay hoặc peer có nghe thấy
mic. `outputRms: 0` là số liệu queue của WebRTC source và cần đối chiếu thêm;
không ghi nhận nó thay cho báo cáo nghe thực tế của người dùng. Bản source hiện
đã được sửa để lưu `lastMediaDiagnostics` sau teardown; cần khởi động lại demo
để nạp thay đổi đó.

Trạng thái: **RX media đã được xác nhận; full-duplex chưa được xác minh bằng
counter uplink.** Lần kế tiếp cần kiểm tra `browserPcmSamples`,
`opusEncodedPackets`, `relayRtpSent` và xác nhận đầu kia nghe được mic web.

Blocker trước E2E là: capability candidate chưa được peer chấp nhận trong call
thật; chưa nhận được answer ACK hoặc media; SRTCP/type5 peer interop chưa có
(offer hiện tại dùng clear RTCP); profile3/noSeq chưa có; chưa có negotiated
RTCP scheduler/jitter buffer; chưa hoàn tất browser hangup/end lifecycle.
Trình tự hợp lý là hoàn tất relay-only
voice cho một mode được offer thật sự chấp nhận, rồi mới cân nhắc P2P hay tối ưu
forward packet.

## Báo cáo chi tiết

- [Checkpoint implementation hiện tại](independent-call-engine.md)
- [Relay lifecycle, registration và teardown](zrtc-relay-lifecycle.md)
- [Audio/RTP/Opus contract](zrtc-audio-contract.md)
- [Capability và SRTCP](zrtc-capabilities-contract.md)
- [Wire envelope](zrtc-transport-findings.md)
- [SRTP](zrtc-srtp-findings.md)
- [Negotiation](zrtc-negotiation-findings.md)
- [Video relay/codec contract and remaining requirements](zrtc-video-contract.md)
