# Call Audio Starter

Một dự án duy nhất gồm frontend React, HTTP backend và server media/audio cho Zalo. FE→BE actions dùng `POST /api/call`; WebSocket `/ws` dùng cho event realtime và media frame. Zalo session, UDP relay, codec Opus, RTP/SRTP và khóa media được giữ ở backend.

## Cấu trúc

```text
examples/call-audio-starter/
  web/                 React UI gọi/nhận audio; browser transport (HTTP + WS events)
  src/call-backend.mjs Zalo listener + relay/media state/action orchestration
  backend/             MediaSession/WebRTC PCM, Opus, ZaloSession, IndependentCall
  server.mjs            HTTP API/static + WebSocket events/media
  ../../src/call/*.ts   canonical RTP/SRTP/ZRTP/negotiation source, compiled locally
```

## Chạy

Tại thư mục này:

```sh
npm install
npm run build
```

Nếu đây là checkout mới và package gốc chưa được build, từ thư mục gốc chạy `bun run build` để tạo `dist/index.js`, sau đó quay lại starter:

```sh
cd ../..
bun run build
cd examples/call-audio-starter
npm start
```

Mở `http://127.0.0.1:4320`, bấm **Liên kết Zalo**, quét QR bằng ứng dụng Zalo, chọn bạn và bấm **Gọi thoại**. Backend này tự thực hiện preflight, caller relay, WebRTC offer/media bridge và signaling. Không cần chạy một demo server thứ hai.

## Luồng audio

```text
React useCall → HTTP call.prepare → ZCA requestcall + UDP caller relay
Browser mic/WebRTC offer → HTTP media.negotiate → backend MediaSession
HTTP call.start → ZCA /request (416)
Zalo control answer → ACK → mở cổng mic RTP/SRTP
Browser WebRTC PCM ⇄ Opus/RTP/SRTP ⇄ Zalo UDP relay
```

Cuộc gọi thực vẫn phụ thuộc Zalo chấp nhận offer/codec, answer/ACK, quyền microphone và mạng UDP. UI chỉ báo media connected khi backend phát trạng thái media; `/requestcall` thành công đơn lẻ chưa có nghĩa người nhận đã đổ chuông.

## HTTP contract FE↔BE

- `zalo.login`, `zalo.status`, `zalo.logout`, `friends.list` — QR, trạng thái account và danh sách rút gọn `{id,name}`.
- `call.prepare`, `media.negotiate`, `call.start` — outgoing audio setup.
- `call.prepare-media`, `media.negotiate`, `call.accept` — incoming answer setup.
- `call.end` — hủy/kết thúc và dọn relay/audio.

WebSocket push events gồm `zalo-qr`, `zalo-state`, `call-incoming`, `call-state`, `media-state`, `media-stats`, `call-error`. Audio chạy WebRTC giữa browser và backend; khóa/session/relay secret không gửi xuống FE.

## Bảo mật

Ví dụ chỉ cho phép same-origin local. Production cần HTTPS/WSS, xác thực app user, phân quyền peer/call, chống CSRF/rate-limit và cô lập Zalo session theo account người dùng. Không ghi cookie, session ID, relay secret hoặc SRTP key vào response/log.

## Kiểm tra

```sh
npm run build
npm test
npm run test:media
npm run test:protocol
```

Protocol tests kiểm tra RTP/SRTP/ZRTP offline theo fixtures/RFC; chúng không tự chứng minh tương thích end-to-end với mọi phiên bản Zalo.
