import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCall } from "@zca-js/call-react/react";
import { createBrowserTransport } from "./transport.js";

function App() {
    const transport = useMemo(() => createBrowserTransport(), []);
    const { client, state, callAudio, answer, hangup, setMuted, setVolume } = useCall({ transport, configUrl: "/api/config" });
    const [muted, setIsMuted] = useState(false);
    const [friends, setFriends] = useState([]);
    const [qr, setQr] = useState(null);
    const [zaloState, setZaloState] = useState("offline");
    const [peerId, setPeerId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [mediaStats, setMediaStats] = useState(null);

    useEffect(() => transport.subscribe((event) => {
        if (event.type === "media-stats") setMediaStats(event);
        if (event.type === "media-state") setMediaStats((current) => ({ ...current, connection: event.state }));
        if (event.type === "connection-state" && event.state === "connected") {
            transport.request("zalo.status").then((status) => setZaloState(status.state || "offline")).catch(() => {});
        }
        if (event.type === "zalo-state") {
            setZaloState(event.state || "offline");
            if (["offline", "expired", "online"].includes(event.state)) setQr(null);
        }
        if (event.type === "zalo-qr") setQr(`data:image/png;base64,${event.image || ""}`);
    }), [transport]);

    useEffect(() => {
        if (zaloState === "online") transport.request("friends.list").then(setFriends).catch((e) => setError(e.message));
    }, [transport, zaloState]);

    const run = async (action) => {
        setBusy(true);
        setError("");
        try { await action(); }
        catch (e) { setError(e.message || "Thao tác thất bại"); }
        finally { setBusy(false); }
    };

    const idle = ["idle", "ended", "error"].includes(state.call);
    return (
        <main>
            <h1>Gọi thoại</h1>
            <p>FE chỉ nói chuyện với backend của ứng dụng. Backend giữ phiên và credential Zalo.</p>
            <div className="status">
                Backend: <strong>{state.gateway}</strong> · Zalo: <strong>{zaloState}</strong> · Cuộc gọi: <strong>{state.call}</strong> · Media: <strong>{state.media}</strong>
                {mediaStats && <div><small>Gateway audio — media: {mediaStats.connection || mediaStats.mode || "?"}; đã nhận {mediaStats.inputSamples || 0} mẫu mic, phát {mediaStats.outputSamples || 0} mẫu ra</small></div>}
            </div>
            {zaloState !== "online" ? (
                <section>
                    <button disabled={zaloState === "connecting" || zaloState === "scanned"} onClick={() => run(() => client.request("zalo.login"))}>
                        {zaloState === "connecting" || zaloState === "scanned" ? "Đang liên kết…" : "Liên kết Zalo"}
                    </button>
                    {qr && <p><img width="220" height="220" src={qr} alt="Mã QR đăng nhập Zalo" /></p>}
                    <p><small>Quét QR trong ứng dụng Zalo. Credential và session chỉ ở backend.</small></p>
                </section>
            ) : null}

            {state.call === "incoming" && (
                <section className="incoming">
                    <h2>Cuộc gọi đến</h2>
                    <p>{state.incoming?.displayName || state.incoming?.peerId || "Người gọi"}</p>
                    <div className="row">
                        <button disabled={busy} onClick={() => run(answer)}>Nghe</button>
                        <button disabled={busy} onClick={() => run(hangup)}>Từ chối</button>
                    </div>
                </section>
            )}

            {idle ? (
                <>
                    <label htmlFor="friend">Gọi cho bạn</label>
                    <div className="row">
                        <select id="friend" value={peerId} onChange={(e) => setPeerId(e.target.value)}>
                            <option value="">Chọn bạn bè</option>
                            {friends.map((friend) => <option key={friend.id} value={friend.id}>{friend.name}</option>)}
                        </select>
                        <button disabled={!peerId || busy || state.gateway !== "connected"} onClick={() => run(() => callAudio(peerId))}>Gọi thoại</button>
                    </div>
                </>
            ) : state.call !== "incoming" ? (
                <div className="row">
                    <button disabled={busy} onClick={() => { const next = !muted; setMuted(next); setIsMuted(next); }}>{muted ? "Bật mic" : "Tắt mic"}</button>
                    <label>Âm lượng <input type="range" min="0" max="1" step="0.05" defaultValue="1" onChange={(e) => setVolume(Number(e.target.value))} /></label>
                    <button disabled={busy} onClick={() => run(hangup)}>Kết thúc</button>
                </div>
            ) : null}

            {(error || state.error) && <p className="error" role="alert">{error || state.error}</p>}
            <small>Không đưa cookie, token Zalo, session ID hoặc khóa media vào trình duyệt.</small>
        </main>
    );
}

createRoot(document.getElementById("root")).render(<App />);
