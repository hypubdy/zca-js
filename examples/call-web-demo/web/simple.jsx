import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useZaloCall } from "../../../packages/call-react/src/react.js";
import { createDemoSessionControls } from "./session-controls.js";
import "./simple.css";

const CALL_LABELS = {
    idle: "Sẵn sàng",
    preparing: "Đang chuẩn bị relay…",
    "relay-ready": "Relay đã sẵn sàng",
    inviting: "Đang gửi lời mời…",
    calling: "Đang gọi…",
    ringing: "Đang đổ chuông…",
    incoming: "Có cuộc gọi đến",
    answering: "Đang nhận cuộc gọi…",
    connecting: "Đang kết nối âm thanh…",
    connected: "Đang đàm thoại",
    ending: "Đang kết thúc…",
    ended: "Cuộc gọi đã kết thúc",
    error: "Cuộc gọi gặp lỗi",
};

function PhoneIcon({ incoming = false }) {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 3 4 4-2 3c1.5 3 3 4.5 6 6l3-2 4 4-1 3c-1 2-7-1-11-5S1 6 3 4Z" />
            {incoming && <path d="M14 3h7v7m0-7-8 8" />}
        </svg>
    );
}

function App() {
    const { client, state, call, answer, hangup } = useZaloCall();
    // Demo-only account controls: these RPCs ask the Node gateway to manage its
    // Zalo session. Authentication itself never runs in the browser call client.
    const session = useMemo(() => createDemoSessionControls(client), [client]);
    const { startQrLogin, reconnect, logout, loadFriends } = session;
    const [friends, setFriends] = useState([]);
    const [calleeId, setCalleeId] = useState("");
    const [callType, setCallType] = useState(1);
    const [busy, setBusy] = useState(false);
    const [localError, setLocalError] = useState("");
    const [cameraStream, setCameraStream] = useState(null);
    const [renderedVideoFrames, setRenderedVideoFrames] = useState(0);
    const [videoError, setVideoError] = useState("");
    const cameraRef = useRef(null);
    const remoteCanvasRef = useRef(null);
    const loadedSession = useRef(false);

    const videoRequested = state.independent?.offerDiagnostics?.videoRequested === true;
    const videoCodecs = state.independent?.offerDiagnostics?.videoCodecs || [];

    const callCameraStream = client.videoCapture?.stream || null;
    useEffect(() => {
        if (cameraRef.current) cameraRef.current.srcObject = callCameraStream || cameraStream || null;
    }, [cameraStream, callCameraStream]);

    useEffect(() => () => cameraStream?.getTracks?.().forEach((track) => track.stop()), [cameraStream]);

    useEffect(() => client.onEvent((event, data) => {
        if (event === "video-error") setVideoError(data?.message || "Video gặp lỗi");
        if (event === "independent-confirmed") { setVideoError(""); setRenderedVideoFrames(0); }
    }), [client]);

    useEffect(() => {
        if (!globalThis.VideoDecoder || !remoteCanvasRef.current) return undefined;
        let decoder;
        try {
            decoder = client.startVideoDecoder({
                onFrame: (frame) => {
                    const canvas = remoteCanvasRef.current;
                    if (!canvas) { frame.close(); return; }
                    canvas.width = frame.displayWidth || frame.codedWidth || 640;
                    canvas.height = frame.displayHeight || frame.codedHeight || 360;
                    canvas.getContext("2d")?.drawImage(frame, 0, 0, canvas.width, canvas.height);
                    frame.close();
                    setRenderedVideoFrames((count) => count + 1);
                },
            });
        } catch (error) { setVideoError(error.message); return undefined; }
        return () => client.stopVideoDecoder();
    }, [client]);

    const toggleCameraPreview = async () => {
        if (cameraStream) {
            cameraStream.getTracks().forEach((track) => track.stop());
            setCameraStream(null);
            return;
        }
        try {
            setLocalError("");
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
            });
            setCameraStream(stream);
        } catch (error) {
            setLocalError(`Không mở được camera: ${error.message}`);
        }
    };

    useEffect(() => {
        if (state.zalo !== "online") {
            loadedSession.current = false;
            setFriends([]);
            setCalleeId("");
            return;
        }
        if (loadedSession.current) return;
        loadedSession.current = true;
        setBusy(true);
        loadFriends()
            .then(setFriends)
            .catch((error) => {
                loadedSession.current = false;
                setLocalError(error.message);
            })
            .finally(() => setBusy(false));
    }, [state.zalo, loadFriends]);

    const run = async (operation) => {
        setBusy(true);
        setLocalError("");
        try {
            await operation();
        } catch (error) {
            setLocalError(error.message);
        } finally {
            setBusy(false);
        }
    };

    const activeCall = !["idle", "ended", "error"].includes(state.call);
    const canCall = state.gateway === "connected" && state.zalo === "online" && calleeId && !activeCall && !busy;
    const statusClass = state.call === "connected" ? "connected" : state.call === "error" ? "failed" : "";

    return (
        <main className="simple-shell">
            <header className="simple-header">
                <div className="logo-mark">Z</div>
                <div>
                    <strong>Zalo Call</strong>
                    <span>Web voice demo</span>
                </div>
                <div className={`gateway ${state.gateway}`} data-testid="gateway-state">
                    <i /> {state.gateway === "connected" ? "Đã kết nối" : "Đang nối gateway"}
                </div>
            </header>

            <section className="account-card">
                <div>
                    <span className="section-label">TÀI KHOẢN</span>
                    <h1>{state.zalo === "online" ? "Zalo đã liên kết" : "Liên kết Zalo để gọi"}</h1>
                    <p>
                        {state.zalo === "online"
                            ? "Sẵn sàng nhận cuộc gọi và gọi cho bạn bè."
                            : state.zalo === "scanned"
                              ? "Đã quét QR, đang hoàn tất đăng nhập…"
                              : "Mã đăng nhập chỉ được xử lý trong gateway trên máy này."}
                    </p>
                </div>

                {state.zalo === "online" ? (
                    <button className="button secondary" disabled={busy || activeCall} onClick={() => run(logout)}>
                        Ngắt liên kết
                    </button>
                ) : state.zalo === "disconnected" ? (
                    <button className="button primary" disabled={busy} onClick={() => run(reconnect)}>
                        Kết nối lại
                    </button>
                ) : (
                    <button
                        className="button primary"
                        disabled={busy || state.zalo === "connecting" || state.zalo === "scanned"}
                        onClick={() => run(startQrLogin)}
                        data-testid="zalo-login"
                    >
                        {state.zalo === "connecting" || state.zalo === "scanned" ? "Đang liên kết…" : "Liên kết Zalo"}
                    </button>
                )}

                {state.qr && (
                    <div className="qr-block">
                        <img src={state.qr} alt="Mã QR đăng nhập Zalo" />
                        <div>
                            <strong>Quét bằng ứng dụng Zalo</strong>
                            <span>Mở Zalo → biểu tượng QR → quét mã</span>
                        </div>
                    </div>
                )}
            </section>

            {state.call === "incoming" && (
                <section className="incoming-card" role="alert" data-testid="incoming-call">
                    <div className="incoming-icon">
                        <PhoneIcon incoming />
                    </div>
                    <div>
                        <span>CUỘC GỌI ĐẾN</span>
                        <h2>{videoRequested ? "Cuộc gọi video Zalo" : "Cuộc gọi thoại Zalo"}</h2>
                        <p>
                            {videoRequested
                                ? `Đã phát hiện offer video${videoCodecs.length ? ` (${videoCodecs.map((codec) => `${codec.name}/${codec.payload}`).join(", ")})` : ""}. Nhấn nghe để mở camera, H.264 và video relay.`
                                : "Nhấn nghe để mở microphone và loa của trình duyệt."}
                        </p>
                    </div>
                    <div className="incoming-actions">
                        <button className="round-button decline" aria-label="Từ chối" onClick={() => run(hangup)}>
                            <PhoneIcon />
                        </button>
                        <button
                            className="round-button accept"
                            aria-label="Nghe"
                            disabled={false}
                            title={videoRequested ? "Nhận cuộc gọi video" : "Nghe cuộc gọi"}
                            onClick={() => run(async () => {
                                cameraStream?.getTracks().forEach(track => track.stop());
                                setCameraStream(null);
                                await answer();
                            })}
                        >
                            <PhoneIcon />
                        </button>
                    </div>
                </section>
            )}

            <section className="call-card">
                <div className={`call-orb ${statusClass} ${activeCall ? "active" : ""}`}>
                    <PhoneIcon />
                </div>
                <span className="section-label">CUỘC GỌI</span>
                <h2 data-testid="call-state">{CALL_LABELS[state.call] || state.call}</h2>
                <p className="media-state">
                    {state.call === "connected"
                        ? "Microphone và loa đang truyền qua trình duyệt"
                        : videoRequested
                          ? "Offer video được nhận diện; camera và H.264 sẽ được mở khi nhấn nghe"
                          : "Chọn một người bạn để bắt đầu cuộc gọi thoại"}
                </p>

                {state.zalo === "online" && !activeCall && (
                    <div className="dial-row">
                        <select value={calleeId} onChange={(event) => setCalleeId(event.target.value)} disabled={busy}>
                            <option value="">{busy ? "Đang tải bạn bè…" : "Chọn bạn bè"}</option>
                            {friends.map((friend) => (
                                <option key={friend.id} value={friend.id}>
                                    {friend.name}
                                </option>
                            ))}
                        </select>
                        <select value={callType} onChange={(event) => setCallType(Number(event.target.value))} disabled={busy} aria-label="Loại cuộc gọi">
                            <option value={1}>Thoại</option>
                            <option value={3}>Video</option>
                        </select>
                        <button
                            className="button call-button"
                            disabled={!canCall}
                            onClick={() => run(async () => {
                                cameraStream?.getTracks().forEach(track => track.stop());
                                setCameraStream(null);
                                await call(calleeId, { callType });
                            })}
                        >
                            <PhoneIcon /> {callType === 3 ? "Gọi video" : "Gọi"}
                        </button>
                    </div>
                )}

                {activeCall && state.call !== "incoming" && (
                    <button
                        className="button end-button"
                        disabled={busy || state.call === "ending"}
                        onClick={() => run(hangup)}
                    >
                        <PhoneIcon /> Kết thúc
                    </button>
                )}

                {state.zalo !== "online" && (
                    <p className="empty-hint">Liên kết tài khoản Zalo để tải danh sách bạn bè.</p>
                )}
            </section>

            <section className="video-card" aria-label="Video preview">
                <div>
                    <span className="section-label">VIDEO</span>
                    <h2>Preview camera trên trình duyệt</h2>
                    <p>Camera đang dùng trong cuộc gọi được hiển thị tại đây. Bộ đếm giúp xác định video đã ra khỏi trình duyệt và video từ bạn bè đã giải mã được hay chưa.</p>
                </div>
                <div className="video-preview-wrap">
                    <video ref={cameraRef} autoPlay muted playsInline aria-label="Local camera preview" />
                    {!callCameraStream && !cameraStream && <span>Camera đang tắt</span>}
                </div>
                <button className="button secondary" onClick={toggleCameraPreview} disabled={Boolean(callCameraStream)}>
                    {callCameraStream ? "Camera cuộc gọi đang bật" : cameraStream ? "Tắt camera" : "Bật camera thử"}
                </button>
                <div className="video-preview-wrap remote-preview">
                    <canvas ref={remoteCanvasRef} aria-label="Remote video" />
                    {!renderedVideoFrames && <span>Chưa giải mã được hình từ bạn bè</span>}
                </div>
                <p className="video-diagnostics">
                    Camera: {callCameraStream?.getVideoTracks?.()[0]?.readyState === "live" ? "đang chạy" : "chưa chạy"} ·
                    Mã hóa: {client.videoCapture?.encodedFrames || 0} frame ·
                    Đã gửi gateway: {client.videoCapture?.sentFrames || 0} frame ·
                    Keyframe đi: {state.independent?.videoKeyFramesSent ?? state.independent?.lastVideoDiagnostics?.keyFramesSent ?? 0} ·
                    RTP đi: {state.independent?.videoPacketsSent || 0} ·
                    RTP đến: {state.independent?.videoPacketsReceived || 0} ·
                    PT phụ (FEC/RTX): {state.independent?.videoAuxiliaryPackets || 0} ·
                    Browser nhận/giải mã: {state.videoClientStats?.received || 0}/{state.videoClientStats?.decoded || 0} ·
                    Lỗi decoder: {state.videoClientStats?.errors || 0} ·
                    Keyframe đến: {state.independent?.videoKeyFramesReceived || 0} ·
                    packetMode: {state.independent?.videoPacketMode ?? state.independent?.lastVideoDiagnostics?.packetMode ?? "?"} ·
                    Format gửi: {state.independent?.videoPacketFormat ?? "auto"} ·
                    Camera-on/suspend: {state.independent?.lastVideoDiagnostics?.cameraOnSignalsSent ?? state.independent?.videoCameraOnSignalsSent ?? 0}/{state.independent?.lastVideoDiagnostics?.suspendSignalsSent ?? state.independent?.videoCameraStateSent ?? 0} ·
                    Báo camera peer (/conf): {state.cameraState?.enabled === true ? "on" : state.cameraState?.enabled === false ? "off" : "chưa gửi"} ·
                    Relay video/PLI/RTCP: {state.independent?.lastVideoDiagnostics?.relayRtpPackets ?? state.independent?.videoRelayRtpPackets ?? 0}/{state.independent?.lastVideoDiagnostics?.pliSent ?? state.independent?.videoPliSent ?? 0}/{state.independent?.lastVideoDiagnostics?.rtcpReportsSent ?? state.independent?.videoRtcpReportsSent ?? 0} ·
                    Audio mic/ra (RMS): {(state.stats?.inputRms ?? 0).toFixed(4)}/{(state.stats?.outputRms ?? 0).toFixed(4)} ·
                    Đã hiện: {renderedVideoFrames} frame
                    {videoError && <> · Lỗi: {videoError}</>}
                </p>
            </section>

            {(localError || state.error) && (
                <div className="error-banner" role="alert">
                    {localError || state.error}
                </div>
            )}

            <footer>
                Audio chạy qua WebRTC; video H.264 đang được kiểm thử tương thích với Zalo · <a href="/">Mở phòng lab</a>
            </footer>
        </main>
    );
}

createRoot(document.getElementById("root")).render(<App />);
