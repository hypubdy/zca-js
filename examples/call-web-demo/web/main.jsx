import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { observeCall, restoreCall } from "./call-notification.mjs";

function Icon({ name, size = 20 }) {
    const paths = {
        mic: (
            <>
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
            </>
        ),
        phone: <path d="m5 3 4 4-2 3c1.5 3 3 4.5 6 6l3-2 4 4-1 3c-1 2-7-1-11-5S1 6 3 4Z" />,
        server: (
            <>
                <rect x="3" y="3" width="18" height="7" rx="2" />
                <rect x="3" y="14" width="18" height="7" rx="2" />
                <path d="M7 6.5h.01M7 17.5h.01M12 6.5h5m-5 11h5" />
            </>
        ),
        sound: (
            <>
                <path d="m3 9 4 0 5-4v14l-5-4H3ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
            </>
        ),
        arrow: <path d="M4 12h16m-5-5 5 5-5 5" />,
        check: <path d="m5 12 4 4L19 6" />,
        power: (
            <>
                <path d="M12 2v10M6 5a9 9 0 1 0 12 0" />
            </>
        ),
        wave: <path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4" />,
        link: (
            <>
                <path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 4 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />
            </>
        ),
    };
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {paths[name] || paths.wave}
        </svg>
    );
}
const modes = [
    { id: "tone", title: "Nghe âm báo", detail: "Tone 440 Hz từ server về trình duyệt", tag: "01" },
    { id: "echo", title: "Thử hai chiều", detail: "Giọng nói → server → phát lại", tag: "02" },
    { id: "zalo", title: "Nối cuộc gọi Zalo", detail: "Engine độc lập · đang xây media", tag: "LAB" },
];

function App() {
    const [processTapAvailable, setProcessTapAvailable] = useState(false);
    const [independent, setIndependent] = useState({ mediaReady: false, offerParsed: false });
    const [incomingCall, setIncomingCall] = useState(null);
    const [backend, setBackend] = useState(false),
        [mode, setMode] = useState("echo"),
        [input, setInput] = useState("mic");
    const [active, setActive] = useState(false),
        [busy, setBusy] = useState(false),
        [connection, setConnection] = useState("Chưa kết nối");
    const [error, setError] = useState(""),
        [helper, setHelper] = useState("stopped"),
        [devices, setDevices] = useState([]);
    const [rxUid, setRxUid] = useState(""),
        [txUid, setTxUid] = useState(""),
        [stats, setStats] = useState({});
    const [levels, setLevels] = useState({ send: 0, receive: 0 }),
        [rtcStats, setRtcStats] = useState({});
    const [logs, setLogs] = useState([]),
        [zalo, setZalo] = useState("offline"),
        [qr, setQr] = useState(""),
        [peer, setPeer] = useState("");
    const [friends, setFriends] = useState([]),
        [friendsLoaded, setFriendsLoaded] = useState(false),
        [friendsBusy, setFriendsBusy] = useState(false);
    const [volume, setVolume] = useState(50),
        [muted, setMuted] = useState(false),
        [micMuted, setMicMuted] = useState(false),
        [elapsed, setElapsed] = useState(0);
    const wsRef = useRef(),
        requests = useRef(new Map()),
        sequence = useRef(0),
        mediaRef = useRef(null),
        started = useRef(0);
    const receiveCanvas = useRef(),
        sendCanvas = useRef(),
        activeRef = useRef(false),
        reconnectTimer = useRef();
    const append = (message, kind = "info") =>
        setLogs((list) => [{ time: new Date().toLocaleTimeString("vi-VN"), message, kind }, ...list].slice(0, 35));
    async function rpc(action, data = {}) {
        const socket = wsRef.current;
        if (socket?.readyState !== WebSocket.OPEN) throw new Error("Backend chưa kết nối");
        const id = ++sequence.current;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                requests.current.delete(id);
                reject(new Error("Server phản hồi quá thời gian chờ"));
            }, 15000);
            requests.current.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (value) => {
                    clearTimeout(timeout);
                    reject(value);
                },
            });
            socket.send(JSON.stringify({ id, action, data }));
        });
    }
    function releaseLocal() {
        const session = mediaRef.current;
        mediaRef.current = null;
        if (session) {
            clearInterval(session.statsTimer);
            cancelAnimationFrame(session.animation);
            session.pc.close();
            session.stream?.getTracks().forEach((track) => track.stop());
            if (session.audio) {
                session.audio.pause();
                session.audio.srcObject = null;
            }
            session.oscillator?.stop();
            session.ctx.close().catch(() => {});
        }
        activeRef.current = false;
        setActive(false);
        setLevels({ send: 0, receive: 0 });
    }
    async function stop() {
        const wasZaloCall = mediaRef.current?.mode === "zalo" || mode === "zalo" && (independent.offerParsed || independent.outgoingRelayRegistered);
        releaseLocal();
        setConnection("Đã dừng");
        setBusy(false);
        await rpc(wasZaloCall ? "call-end" : "media-stop").catch((error) => {
            if (wasZaloCall) setError(`Đã dừng audio cục bộ; chưa gửi được tín hiệu kết thúc: ${error.message}`);
        });
        append(wasZaloCall ? "Đã dừng audio, gửi cancel/endcall theo phase và đóng relay nếu còn hoạt động." : "Đã đóng WebRTC và giải phóng audio.");
    }
    useEffect(() => {
        let disposed = false;
        function connect() {
            const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
            wsRef.current = socket;
            socket.onopen = () => {
                setBackend(true);
                append("Đã kết nối backend.");
                rpc("devices")
                    .then(setDeviceOptions)
                    .catch((e) => append(e.message, "error"));
            };
            socket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (message.id) {
                    const pending = requests.current.get(message.id);
                    requests.current.delete(message.id);
                    if (message.ok) pending?.resolve(message.data);
                    else pending?.reject(new Error(message.error));
                    return;
                }
                const { event: type, data } = message;
                if (type === "snapshot") {
                    setProcessTapAvailable(Boolean(data.processTapAvailable));
                    setIndependent(data.independent || { mediaReady: false, offerParsed: false });
                    setHelper(data.helper);
                    setZalo(data.zalo);
                    setDeviceOptions(data.devices || []);
                    setIncomingCall(restoreCall(data.log));
                    for (const entry of (data.log || [])
                        .filter((item) => item.event === "incoming-control")
                        .slice(-6)) {
                        append(
                            `Zalo control: ${entry.data.action} · ${new Date(entry.time).toLocaleTimeString("vi-VN")}`,
                        );
                    }
                    for (const entry of (data.log || [])
                        .filter((item) => item.event === "outgoing-call-stage" || item.event === "outgoing-call-error")
                        .slice(-8)) {
                        const info = entry.data || {};
                        const flow = { preflight: "preflight", relay: "caller relay", invite: "lời mời" }[info.flow] || info.flow || "unknown";
                        const when = new Date(entry.time).toLocaleTimeString("vi-VN");
                        if (entry.event === "outgoing-call-error") {
                            append(`Gọi đi lỗi tại ${flow}/${info.stage || "unknown"}` +
                                `${info.errorCode !== undefined ? ` · mã ${info.errorCode}` : ""}` +
                                `${info.errorName ? ` · ${info.errorName}` : ""}: ${info.message || "lỗi không rõ"} · ${when}`, "error");
                        } else {
                            append(`Gọi đi · ${flow}: ${info.stage || "unknown"} · ${when}`);
                        }
                    }
                } else if (type === "independent-state") {
                    setIndependent(data);
                } else if (type === "independent-offer") {
                    append(`Offer chẩn đoán an toàn: ${JSON.stringify(data)}`);
                } else if (type === "independent-answer") {
                    append(data.waitingForPeerAck
                        ? "Zalo đã nhận answer signaling; chờ ACK của caller. Audio TX vẫn khóa."
                        : "Answer signaling đã gửi.");
                } else if (type === "independent-confirmed") {
                    setIncomingCall((previous) => previous ? { ...previous, status: "confirmed" } : previous);
                    append("Caller ACK đã khớp call ID; cuộc gọi được xác nhận.");
                } else if (type === "independent-outgoing-answer") {
                    append(`Caller nhận answer · call ID ${data.callId} · status ${data.status} · codec ${data.codecs?.map(codec => codec.name).join(", ") || "không có"}. Chưa coi là connected trước khi relay/media/ACK hoàn tất.`);
                } else if (type === "independent-outgoing-ringing") {
                    append(`Bạn bè đã nhận lời mời gọi · call ID ${data.callId} · đang chờ answer.`);
                } else if (type === "outgoing-call-stage") {
                    const flow = { preflight: "preflight", relay: "caller relay", invite: "lời mời" }[data.flow] || data.flow;
                    const stage = {
                        "rpc-received": "backend đã nhận thao tác",
                        "requestcall-start": "đang gửi /requestcall",
                        "response-parsed": "đã đọc response preflight",
                        "registration-start": "bắt đầu đăng ký relay",
                        "candidate-start": "đang thử relay candidate",
                        "candidate-registered": "đăng ký relay thành công",
                        "caller-relay-ready": "caller relay sẵn sàng",
                        "preflight-only": "chỉ có preflight, relay chưa đăng ký",
                        "request-start": "đang gửi /request",
                        "request-accepted": "Zalo đã nhận /request",
                    }[data.stage] || data.stage;
                    const candidate = data.candidateIndex ? ` · candidate ${data.candidateIndex}/${data.candidateCount ?? "?"}` : "";
                    const summary = data.relayCandidates !== undefined ? ` · ${data.relayCandidates} candidate(s)` : "";
                    const status = data.status !== undefined ? ` · status ${data.status}` : "";
                    append(`Gọi đi · ${flow}: ${stage}${candidate}${summary}${status}`);
                } else if (type === "outgoing-call-error") {
                    append(`Gọi đi lỗi tại ${data.flow || "unknown"}/${data.stage || "unknown"}` +
                        `${data.errorCode !== undefined ? ` · mã ${data.errorCode}` : ""}` +
                        `${data.errorName ? ` · ${data.errorName}` : ""}: ${data.message || "lỗi không rõ"}`, "error");
                } else if (type === "independent-relay") {
                    append(data.registered
                        ? "Relay độc lập đã đăng ký; socket và keepalive đang giữ. Chưa nhận cuộc gọi."
                        : `Relay độc lập: status ${data.status}; chưa thiết lập cuộc gọi/audio.`);
                } else if (type === "independent-relay-starting") {
                    append("Có lời mời mới; backend đang tự đăng ký relay trước khi bạn nhận cuộc gọi.");
                } else if (type === "independent-media") {
                    append(`Relay đã xác thực và giải mã ${data.decodedPackets} gói ${data.kind}; đưa audio vào WebRTC trình duyệt.`);
                } else if (type === "media-stats") {
                    setStats(data);
                    window.__callDemoStats = data;
                } else if (type === "helper-state") {
                    setHelper(data.state);
                    append(data.state === "ready" ? "ZaloCall helper: IPC sẵn sàng." : "Đã dừng helper.");
                } else if (type === "media-state") {
                    setConnection(data.state);
                    append(`WebRTC: ${data.state}`);
                } else if (type === "media-ended") {
                    if (activeRef.current) {
                        releaseLocal();
                        setConnection("Đã dừng");
                        append("Server đã đóng phiên audio.");
                    }
                } else if (type === "zalo-qr") {
                    setQr(data.image.startsWith("data:") ? data.image : `data:image/png;base64,${data.image}`);
                } else if (type === "zalo-state") {
                    setZalo(data.state);
                    if (data.state === "online" || data.state === "offline") setQr("");
                    if (data.state === "offline") { setFriends([]); setFriendsLoaded(false); setPeer(""); }
                    append(data.message || `Zalo: ${data.state}`);
                } else if (type === "zalo-control-batch") {
                    append(data.validBatch
                        ? `Control stream cmd=601: ${data.controlCount} event(s), ${data.voipCount} VoIP${data.actions?.length ? ` · ${data.actions.join(", ")}` : ""}`
                        : "Control stream cmd=601: payload không có danh sách controls hợp lệ", data.validBatch ? "info" : "error");
                } else if (type === "incoming-control") {
                    setIncomingCall((previous) => observeCall(previous, data.action));
                    append(`Zalo control: ${data.action}`);
                } else if (type === "call-state") {
                    append(`Cuộc gọi: ${data.state}`);
                    if (data.state === "free" && mediaRef.current?.mode === "zalo") {
                        releaseLocal(); setConnection("Cuộc gọi đã kết thúc");
                    }
                }
                else if (type === "zalo-signal") append(`Signaling ${data.action}: đã gửi.`);
                else if (type === "incoming-forwarded") append("Đã chuyển cuộc gọi đến sang ZaloCall với audio route sẵn sàng.");
                else if (type === "native-answer-required") { setError(data.message); append(data.message); }
                else if (type.endsWith("error")) {
                    setError(data.message);
                    append(data.message, "error");
                }
            };
            socket.onclose = () => {
                setBackend(false);
                releaseLocal();
                setConnection("Backend ngắt kết nối");
                for (const pending of requests.current.values()) pending.reject(new Error("Backend đã ngắt kết nối"));
                requests.current.clear();
                if (!disposed) reconnectTimer.current = setTimeout(connect, 2000);
            };
            socket.onerror = () => {};
        }
        connect();
        return () => {
            disposed = true;
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
            releaseLocal();
        };
    }, []);
    useEffect(() => {
        if (incomingCall?.status !== "ringing") return;
        const timer = setTimeout(
            () =>
                setIncomingCall((previous) =>
                    previous?.at === incomingCall.at ? { ...previous, status: "stale" } : previous,
                ),
            Math.max(0, incomingCall.at + 60000 - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [incomingCall]);
    function setDeviceOptions(list) {
        setDevices(list);
        const inputDevice = list.find(
            (device) => device.virtual && device.inputChannels === 1 && device.inputSampleRate === 48000,
        );
        const outputDevice = list.find(
            (device) => device.virtual && device.outputChannels === 1 && device.outputSampleRate === 48000,
        );
        if (inputDevice) setRxUid((value) => value || inputDevice.uid);
        if (outputDevice) setTxUid((value) => value || outputDevice.uid);
    }
    useEffect(() => {
        if (mediaRef.current?.playback) mediaRef.current.playback.gain.value = muted ? 0 : volume / 100;
    }, [volume, muted]);
    useEffect(() => {
        for (const track of mediaRef.current?.stream?.getAudioTracks() || []) track.enabled = !micMuted;
    }, [micMuted, active]);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [active]);
    function visualize(session) {
        function draw(analyser, canvas, color) {
            if (!canvas) return 0;
            const ctx = canvas.getContext("2d"),
                width = canvas.width,
                height = canvas.height;
            ctx.clearRect(0, 0, width, height);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            const points = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(points);
            let energy = 0;
            for (let i = 0; i < points.length; i++) {
                energy += points[i] ** 2;
                const x = (i / points.length) * width,
                    y = height / 2 + points[i] * height * 1.8;
                if (!i) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            return Math.sqrt(energy / points.length);
        }
        let tick = 0;
        const frame = () => {
            const send = draw(session.sendAnalyser, sendCanvas.current, "#6fffc4");
            const receive = draw(session.receiveAnalyser, receiveCanvas.current, "#82b8ff");
            if (tick++ % 10 === 0) {
                setLevels({ send, receive });
                window.__callDemoLevels = { send, receive };
            }
            session.animation = requestAnimationFrame(frame);
        };
        frame();
    }
    async function start(options = {}) {
        const selectedMode = options.mode || mode;
        const selectedInput = options.input || input;
        if (busy || active) return;
        setError("");
        setBusy(true);
        setConnection("Đang chuẩn bị audio…");
        setStats({});
        setRtcStats({});
        window.__callDemoStats = null;
        window.__callDemoRtc = null;
        window.__callDemoLevels = { send: 0, receive: 0 };
        try {
            const ctx = new AudioContext({ sampleRate: 48000 });
            await ctx.resume();
            const { iceServers } = await fetch("/api/config").then((res) => res.json());
            const pc = new RTCPeerConnection({ iceServers });
            const session = { pc, ctx, input: selectedInput, mode: selectedMode };
            mediaRef.current = session;
            window.__callDemoAudioState = () => ({
                context: ctx.state,
                localTracks: session.stream?.getTracks().map((track) => track.readyState),
                micEnabled: session.stream?.getAudioTracks().map(track => track.enabled),
                track: session.remoteTrack && {
                    enabled: session.remoteTrack.enabled,
                    muted: session.remoteTrack.muted,
                    state: session.remoteTrack.readyState,
                },
                elementPaused: session.audio?.paused,
                elementReady: session.audio?.readyState,
            });
            session.sendAnalyser = ctx.createAnalyser();
            session.sendAnalyser.fftSize = 1024;
            session.receiveAnalyser = ctx.createAnalyser();
            session.receiveAnalyser.fftSize = 1024;
            session.playback = ctx.createGain();
            session.playback.gain.value = muted ? 0 : volume / 100;
            session.receiveAnalyser.connect(session.playback).connect(ctx.destination);
            if (selectedInput === "mic" && selectedMode !== "tone") {
                if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone cần HTTPS hoặc localhost.");
                session.stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
                    video: false,
                });
                ctx.createMediaStreamSource(session.stream).connect(session.sendAnalyser);
                append("Đã cấp quyền mic. Nên dùng tai nghe khi thử phát lại.");
            } else {
                const destination = ctx.createMediaStreamDestination(),
                    oscillator = ctx.createOscillator(),
                    gain = ctx.createGain();
                oscillator.frequency.value = 440;
                gain.gain.value = selectedMode === "tone" ? 0 : 0.1;
                oscillator.connect(gain);
                gain.connect(destination);
                gain.connect(session.sendAnalyser);
                oscillator.start();
                session.stream = destination.stream;
                session.oscillator = oscillator;
                append(
                    selectedMode === "tone"
                        ? "Đang nghe tone do server phát; không mở mic."
                        : "Nguồn thử: tone 440 Hz từ trình duyệt; không mở mic.",
                );
            }
            for (const track of session.stream.getTracks()) { track.enabled = !micMuted; pc.addTrack(track, session.stream); }
            pc.ontrack = (event) => {
                session.remoteTrack = event.track;
                const stream = event.streams[0] || new MediaStream([event.track]);
                // Keep a media element consuming the remote track. Chromium can otherwise
                // leave remote audio silent when only a MediaStreamAudioSourceNode exists.
                session.audio = new Audio();
                session.audio.srcObject = stream;
                session.audio.muted = true;
                session.remote = ctx.createMediaStreamSource(stream);
                session.remote.connect(session.receiveAnalyser);
                session.audio
                    .play()
                    .catch(() => setError("Trình duyệt chặn phát audio. Cho phép âm thanh cho localhost rồi thử lại."));
                append("Đã nhận audio track từ server.");
            };
            pc.onconnectionstatechange = () => {
                setConnection(pc.connectionState);
                if (pc.connectionState === "failed") {
                    setError("WebRTC không kết nối được. Kiểm tra ICE / TURN nếu dùng server từ xa.");
                    stop();
                }
            };
            await pc.setLocalDescription(await pc.createOffer());
            if (pc.iceGatheringState !== "complete")
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("ICE timeout")), 8000);
                    pc.onicegatheringstatechange = () => {
                        if (pc.iceGatheringState === "complete") {
                            clearTimeout(timer);
                            resolve();
                        }
                    };
                });
            const answer = await rpc("media-offer", {
                mode: selectedMode,
                input: selectedInput,
                inputUid: rxUid,
                outputUid: txUid,
                offer: pc.localDescription.toJSON(),
            });
            await pc.setRemoteDescription(answer);
            activeRef.current = true;
            setActive(true);
            started.current = Date.now();
            setElapsed(0);
            visualize(session);
            session.statsTimer = setInterval(async () => {
                if (pc.connectionState !== "connected") return;
                const report = await pc.getStats();
                const next = {};
                report.forEach((stat) => {
                    if (stat.type === "inbound-rtp" && stat.kind === "audio") {
                        next.received = stat.bytesReceived;
                        next.packetsLost = stat.packetsLost;
                        next.jitter = Math.round((stat.jitter || 0) * 1000);
                        next.audioLevel = stat.audioLevel;
                        next.totalAudioEnergy = stat.totalAudioEnergy;
                        next.concealedSamples = stat.concealedSamples;
                        next.totalSamplesReceived = stat.totalSamplesReceived;
                    }
                    if (stat.type === "outbound-rtp" && stat.kind === "audio") next.sent = stat.bytesSent;
                    if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated)
                        next.rtt = Math.round((stat.currentRoundTripTime || 0) * 1000);
                });
                setRtcStats(next);
                window.__callDemoRtc = next;
            }, 1000);
            return true;
        } catch (e) {
            releaseLocal();
            await rpc("media-stop").catch(() => {});
            const text =
                e.name === "NotAllowedError"
                    ? "Chưa được cấp quyền microphone. Cho phép mic hoặc chọn nguồn tone thử."
                    : e.message;
            setError(text);
            setConnection("Chưa kết nối");
            append(text, "error");
            return false;
        } finally {
            setBusy(false);
        }
    }
    async function action(fn) {
        setError("");
        try {
            await fn();
        } catch (e) {
            setError(e.message);
            append(e.message, "error");
        }
    }
    async function acceptIncoming() {
        setMode("zalo"); setInput("mic");
        if (!active && !await start({ mode: "zalo", input: "mic" })) return;
        await action(async () => {
            const session = mediaRef.current;
            if (session.input !== "mic") {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
                const track = stream.getAudioTracks()[0];
                try {
                    track.enabled = !micMuted;
                    await session.pc.getSenders().find(sender => sender.track?.kind === "audio").replaceTrack(track);
                } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
                session.stream.getTracks().forEach(track => track.stop());
                session.oscillator?.stop(); session.oscillator = null;
                session.stream = stream; session.input = "mic";
                session.ctx.createMediaStreamSource(stream).connect(session.sendAnalyser);
            }
            const result = await rpc("call-accept");
            if (result.responseReceived) append("Answer signaling được server chấp nhận; đang chờ caller ACK, audio TX vẫn khóa.");
        });
    }
    async function loadFriends() {
        if (friendsBusy) return;
        setFriendsBusy(true);
        try {
            await action(async () => {
                const result = await rpc("zalo-friends");
                setFriends(Array.isArray(result) ? result : []);
                setFriendsLoaded(true);
                append(`Đã tải ${Array.isArray(result) ? result.length : 0} bạn bè (chỉ tên và ID).`);
            });
        } finally { setFriendsBusy(false); }
    }
    async function tryOutgoingCall() {
        if (friendsBusy) return;
        const friend = friends.find(item => item.id === peer);
        if (!friend) return;
        setFriendsBusy(true);
        try {
            await action(async () => {
                const result = await rpc("call-outgoing-preflight", { calleeId: friend.id });
                append(`Preflight audio tới ${friend.name} · call ID ${result.callId} · status ${result.status} · ${result.relayCandidates} relay candidate · caller relay ${result.callerRelayRegistered ? "đã đăng ký" : "chưa đăng ký"}. Chưa phát chuông; media negotiation và /request chưa chạy.`);
            });
        } finally { setFriendsBusy(false); }
    }
    async function sendOutgoingInvite() {
        if (friendsBusy) return;
        const friend = friends.find(item => item.id === peer);
        if (!friend) return;
        setFriendsBusy(true);
        try {
            setMode("zalo");
            setInput("mic");
            if (!active && !await start({ mode: "zalo", input: "mic" })) return;
            await action(async () => {
                const session = mediaRef.current;
                if (!session || session.mode !== "zalo" || session.input !== "mic")
                    throw new Error("Hãy dừng phiên âm thanh hiện tại rồi bấm Gọi bạn lại để mở microphone Zalo");
                const result = await rpc("call-outgoing-invite", { calleeId: friend.id });
                append(`Đã gửi caller /request tới ${friend.name} · call ID ${independent.outgoingCallId ?? "đang xử lý"}. Chờ Zalo báo ringing/answer.`);
            });
        } finally { setFriendsBusy(false); }
    }
    const virtualInputs = devices.filter(
        (device) => device.virtual && device.inputChannels === 1 && device.inputSampleRate === 48000,
    );
    const virtualOutputs = devices.filter(
        (device) => device.virtual && device.outputChannels === 1 && device.outputSampleRate === 48000,
    );
    const nativeMode = mode === "virtual";
    const liveBlocked = mode === "zalo" && !independent.browserBridgeAvailable;
    const duration = `${Math.floor(elapsed / 60)
        .toString()
        .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
    const formatBytes = (value) => (value ? `${(value / 1024).toFixed(1)} KB` : "—");
    return (
        <div className="app-shell">
            <aside className="sidebar">
                <a className="brand" href="/" aria-label="ZCA Call Lab">
                    <span className="brand-icon">
                        <Icon name="wave" size={25} />
                    </span>
                    <span>
                        zca<span className="brand-light"> / lab</span>
                    </span>
                </a>
                <div className="workspace">
                    <span className="tiny-dot" />
                    LOCAL WORKSPACE<span className="workspace-os">macOS</span>
                </div>
                <div className="sidebar-label">PHÒNG THỬ NGHIỆM</div>
                <div className="nav-active">
                    <Icon name="phone" /> Voice bridge <span className="nav-badge">01</span>
                </div>
                <div className="sidebar-card">
                    <span className="eyebrow">KIẾN TRÚC ĐANG THỬ</span>
                    <h3>Web → Native</h3>
                    <p>
                        Trình duyệt giữ mic và loa.
                        <br />
                        Mac xử lý cầu nối âm thanh.
                    </p>
                    <div className="mini-flow">
                        <span>React</span>
                        <Icon name="arrow" size={15} />
                        <span>Node</span>
                        <Icon name="arrow" size={15} />
                        <span>Mac</span>
                    </div>
                </div>
                <div className="sidebar-bottom">
                    <span className={`tiny-dot ${backend ? "green" : "red"}`} />
                    <div>
                        {backend ? "Backend đang hoạt động" : "Đang kết nối backend…"}
                        <small>localhost · một phiên audio</small>
                    </div>
                </div>
            </aside>
            <main>
                <header className="topbar">
                    <span>
                        Workspace <span className="slash">/</span> Audio experiments
                    </span>
                    <span className="environment">
                        <span className="tiny-dot green" /> DEVELOPMENT
                    </span>
                </header>
                <div className="content">
                    <div className="page-heading">
                        <div>
                            <div className="eyebrow dark">REALTIME AUDIO · PROTOTYPE 01</div>
                            <h1>
                                Voice bridge<span className="heading-dot">.</span>
                            </h1>
                            <p>Thử luồng âm thanh hai chiều giữa trình duyệt và server.</p>
                        </div>
                        <span className="version">
                            ZCA CALL LAB <span>v0.1</span>
                        </span>
                    </div>
                    {incomingCall && (
                        <div
                            className={`incoming-call ${incomingCall.status === "ringing" ? "ringing" : ""}`}
                            role={incomingCall.status === "ringing" ? "alert" : "status"}
                            data-testid="incoming-call"
                        >
                            <Icon name="phone" size={26} />
                            <div>
                                <strong>
                                    {incomingCall.status === "ringing"
                                        ? "Có cuộc gọi Zalo đến"
                                        : incomingCall.status === "confirmed"
                                          ? "Cuộc gọi Zalo đã được xác nhận"
                                        : incomingCall.status === "stale"
                                          ? "Đã ghi nhận cuộc gọi đến trước đó"
                                          : "Cuộc gọi Zalo đã kết thúc"}
                                </strong>
                                <p>
                                    {incomingCall.status === "ringing"
                                        ? independent.offerDiagnostics?.videoRequested
                                            ? "Offer yêu cầu video. Video chưa được thương lượng/kiểm thử, nên nút answer đang khóa để tránh nhận sai media."
                                            : active && mode === "zalo"
                                            ? "Cầu audio trình duyệt đã dựng. Nhận sẽ gửi answer thử nghiệm; audio TX chỉ mở sau caller ACK."
                                            : "Đã nhận signaling. Đăng ký relay trước, rồi chuẩn bị audio trình duyệt để thử answer."
                                        : incomingCall.status === "confirmed"
                                          ? "Caller ACK đã khớp; mic RTP/SRTP được mở. Kiểm tra tiếng nói hai chiều trong trình duyệt."
                                        : `Sự kiện ${incomingCall.action} lúc ${new Date(incomingCall.at).toLocaleTimeString("vi-VN")}. Đây là thông báo sự kiện, không phải xác nhận audio đã kết nối.`}
                                </p>
                            </div>
                            {incomingCall.status === "ringing" && <button disabled={!backend || busy || zalo !== "online" || !independent.answerTrialAvailable || (active && mode !== "zalo")} onClick={acceptIncoming}>
                                {independent.answerSignalSent ? "Đang chờ ACK" : "Thử nhận cuộc gọi"}
                            </button>}
                            <button onClick={() => setIncomingCall(null)}>Ẩn thông báo</button>
                        </div>
                    )}
                    <div className="notice">
                        <span className="notice-icon">i</span>
                        <span>
                            <strong>Demo kết nối audio.</strong> Các bài thử không gọi điện. Chế độ Zalo thật là thử
                            nghiệm riêng, chưa xác minh end-to-end.
                        </span>
                    </div>
                    <div className="main-grid">
                        <section className="studio">
                            <div className="studio-top">
                                <span className="eyebrow">AUDIO SESSION</span>
                                <span
                                    className={`status-pill ${active && connection === "connected" ? "connected" : ""}`}
                                >
                                    <span className="tiny-dot" />
                                    {active
                                        ? connection === "connected"
                                            ? "ĐANG TRUYỀN AUDIO"
                                            : connection
                                        : "SẴN SÀNG THỬ"}
                                </span>
                            </div>
                            <div className="call-avatar">
                                <Icon name={mode === "zalo" ? "phone" : "wave"} size={40} />
                                <span className={active ? "avatar-indicator on" : "avatar-indicator"} />
                            </div>
                            <h2>{modes.find((item) => item.id === mode).title}</h2>
                            <p className="session-subtitle">
                                {active
                                    ? `Phiên ${duration} · ${input === "mic" && mode !== "tone" ? "Microphone" : "Test tone"}`
                                    : "Chọn bài thử, rồi mở kết nối WebRTC"}
                            </p>
                            <div className={`signal-path ${active ? "running" : ""}`}>
                                <div>
                                    <Icon name="mic" />
                                    <span>Trình duyệt</span>
                                </div>
                                <span className="path-line" />
                                <div>
                                    <Icon name="server" />
                                    <span>Node gateway</span>
                                </div>
                                <span className="path-line" />
                                <div>
                                    <Icon name={nativeMode ? "link" : "sound"} />
                                    <span>{nativeMode ? "CoreAudio" : "Audio trả về"}</span>
                                </div>
                            </div>
                            <div className="waveforms">
                                <div className="wave-row">
                                    <div>
                                        <span className="tiny-dot green" />
                                        GỬI LÊN <b>{Math.round(Math.min(1, levels.send) * 100)}%</b>
                                    </div>
                                    <canvas width="560" height="44" ref={sendCanvas} />
                                </div>
                                <div className="wave-row">
                                    <div>
                                        <span className="tiny-dot blue" />
                                        NHẬN VỀ <b>{Math.round(Math.min(1, levels.receive) * 100)}%</b>
                                    </div>
                                    <canvas width="560" height="44" ref={receiveCanvas} />
                                </div>
                            </div>
                            {liveBlocked && <p className="live-gate">Chưa có caller relay/media cho mode Zalo. Với cuộc gọi đi, trước hết chọn bạn và bấm “Chuẩn bị gọi đi”; bước này tự đăng ký relay. Nút relay cuộc gọi đến không dùng cho outgoing.</p>}
                            <div className="session-controls">
                                <button
                                    className="start-button"
                                    data-testid="start"
                                    disabled={
                                        !backend || busy || active || liveBlocked || (nativeMode && (!txUid || (!(mode === "zalo" && processTapAvailable) && !rxUid)))
                                    }
                                    onClick={start}
                                >
                                    <Icon name="power" />
                                    {busy ? "Đang kết nối…" : "Bắt đầu thử âm thanh"}
                                </button>
                                <button
                                    className="stop-button"
                                    data-testid="stop"
                                    disabled={!active && !busy && !independent.offerParsed && !independent.outgoingRelayRegistered}
                                    onClick={stop}
                                >
                                    <span className="stop-square" /> {mode === "zalo" ? "Kết thúc cuộc gọi" : "Dừng"}
                                </button>
                            </div>
                            <div className="volume-control">
                                <button disabled={!active || input !== "mic" || mode === "tone"}
                                    onClick={() => setMicMuted(value => !value)}
                                    aria-label={micMuted ? "Bật mic" : "Tắt mic"} aria-pressed={micMuted}>
                                    <Icon name="mic" size={17} /> {micMuted ? "Bật mic" : "Tắt mic"}
                                </button>
                                <button
                                    className={muted ? "muted" : ""}
                                    onClick={() => setMuted((value) => !value)}
                                    aria-label={muted ? "Bật loa" : "Tắt loa"}
                                >
                                    <Icon name="sound" size={17} />
                                </button>
                                <input
                                    aria-label="Âm lượng phát"
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={volume}
                                    onChange={(e) => setVolume(Number(e.target.value))}
                                />
                                <span>{muted ? "Tắt" : `${volume}%`}</span>
                                <span className="headphone-note">Nên dùng tai nghe khi thử mic</span>
                            </div>
                            {error && (
                                <div className="error-box" role="alert">
                                    {error}
                                </div>
                            )}
                        </section>
                        <section className="configuration panel">
                            <div className="panel-title">
                                <h2>Cấu hình bài thử</h2>
                                <span>SETUP</span>
                            </div>
                            <label className="field-label">
                                01 <span>Đường truyền</span>
                            </label>
                            <div className="mode-list">
                                {modes.map((item) => (
                                    <button
                                        key={item.id}
                                        className={`mode-option ${mode === item.id ? "selected" : ""}`}
                                        disabled={active || busy}
                                        data-testid={`mode-${item.id}`}
                                        onClick={() => setMode(item.id)}
                                    >
                                        <span className="radio" />
                                        <span>
                                            <strong>{item.title}</strong>
                                            <small>{item.detail}</small>
                                        </span>
                                        <span className="mode-tag">{item.tag}</span>
                                    </button>
                                ))}
                            </div>
                            <label className="field-label">
                                02 <span>Nguồn từ trình duyệt</span>
                            </label>
                            <div className="segmented">
                                <button
                                    data-testid="source-mic"
                                    disabled={active || busy || mode === "tone"}
                                    className={input === "mic" ? "selected" : ""}
                                    onClick={() => setInput("mic")}
                                >
                                    <Icon name="mic" size={16} /> Microphone
                                </button>
                                <button
                                    data-testid="source-tone"
                                    disabled={active || busy}
                                    className={input === "tone" ? "selected" : ""}
                                    onClick={() => setInput("tone")}
                                >
                                    <Icon name="wave" size={16} /> Tone 440 Hz
                                </button>
                            </div>
                            {nativeMode && (
                                <div className="device-fields">
                                    <label>
                                        RX · Mac → trình duyệt
                                        {mode === "zalo" && processTapAvailable ? <p>CoreAudio process tap riêng của ZaloCall · không trộn tiếng gửi</p> : <select
                                            disabled={active}
                                            value={rxUid}
                                            onChange={(e) => setRxUid(e.target.value)}
                                        >
                                            <option value="">Chọn virtual input</option>
                                            {virtualInputs.map((device) => (
                                                <option key={device.uid} value={device.uid}>
                                                    {device.name}
                                                </option>
                                            ))}
                                        </select>}
                                    </label>
                                    <label>
                                        TX · trình duyệt → Mac
                                        <select
                                            disabled={active}
                                            value={txUid}
                                            onChange={(e) => setTxUid(e.target.value)}
                                        >
                                            <option value="">Chọn virtual output</option>
                                            {virtualOutputs.map((device) => (
                                                <option key={device.uid} value={device.uid}>
                                                    {device.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <p>
                                        {mode === "virtual"
                                            ? "Bài loopback dùng chung một thiết bị ảo để nghe lại nguồn gửi."
                                            : processTapAvailable ? "Nhận qua process tap; gửi qua thiết bị ảo TX. Hai chiều tách biệt, không dùng loopback chung." : "Cuộc gọi thật cần hai bus độc lập. Một bus chung sẽ tạo vòng lặp âm thanh."}
                                    </p>
                                </div>
                            )}
                            <div className="config-foot">
                                <Icon name="check" size={16} />
                                <span>WebRTC audio · PCM 48 kHz mono</span>
                            </div>
                        </section>
                    </div>
                    <div className="metric-grid">
                        {[
                            ["DỮ LIỆU GỬI", formatBytes(rtcStats.sent), "Browser → server"],
                            ["DỮ LIỆU NHẬN", formatBytes(rtcStats.received), "Server → browser"],
                            ["ROUND-TRIP", rtcStats.rtt !== undefined ? `${rtcStats.rtt} ms` : "—", "WebRTC transport"],
                            [
                                "PCM QUA MAC",
                                stats.nativeInputSamples ? stats.nativeInputSamples.toLocaleString("vi-VN") : "—",
                                "Mẫu nhận từ CoreAudio",
                            ],
                        ].map(([title, value, caption]) => (
                            <div className="metric" key={title}>
                                <span>{title}</span>
                                <strong>{value}</strong>
                                <small>{caption}</small>
                            </div>
                        ))}
                    </div>
                    <div className="bottom-grid">
                        <section className="panel native-panel">
                            <div className="panel-title">
                                <h2>Engine cuộc gọi độc lập</h2>
                                <span className="worker-state">KHÔNG ZALOCALL</span>
                            </div>
                            <p>Backend không khởi chạy ZaloCall. Sau khi relay và RTP/SRTP sẵn sàng, có thể nối mic và loa trình duyệt qua PCM/Opus. Trạng thái này chưa có nghĩa cuộc gọi đã được answer.</p>
                            {independent.offerParsed && <button className="outline-button" disabled={!backend || zalo !== "online" || independent.relayRegistered || independent.relayConnecting}
                                onClick={() => action(() => rpc("call-relay-connect"))}>{independent.relayConnecting ? "Đang kết nối relay cuộc gọi đến…" : "Kết nối lại relay cuộc gọi đến"}</button>}
                            {independent.offerDiagnostics && (
                                <p>Offer media: {independent.offerDiagnostics.videoRequested ? "video" : "thoại"} · callType {independent.offerDiagnostics.callType ?? "chưa khai báo"} · video.enable {independent.offerDiagnostics.videoEnable ?? "chưa có"} · codec {independent.offerDiagnostics.videoCodecId ?? (independent.offerDiagnostics.videoCodecIds?.join(", ") || "chưa có")}</p>
                            )}
                            <p>{independent.relayRegistered
                                ? independent.browserBridgeAvailable
                                    ? independent.confirmed
                                        ? "Relay/audio đã sẵn sàng và caller ACK đã xác nhận. Mic gửi qua RTP/SRTP; kiểm tra tiếng nói hai chiều."
                                        : independent.answerSignalSent
                                            ? "Answer đã được server nhận; đang chờ caller ACK. Mic TX vẫn khóa."
                                            : "Relay, Opus và SRTP RTP đã sẵn sàng. Bấm Thử nhận cuộc gọi để chuẩn bị mic/loa trình duyệt và gửi answer candidate. Mic TX chỉ mở sau caller ACK."
                                    : "Relay đã đăng ký; socket được giữ tới khi cuộc gọi kết thúc hoặc phiên sự kiện mất kết nối. RTP/SRTP chưa sẵn sàng, chưa thể nối audio."
                                : "Chỉ kết nối tới relay trong lời mời gọi mới; thao tác này chưa nhận cuộc gọi và không mở mic."}</p>
                            {independent.mediaDiagnostics && (
                                <small className="media-diagnostics">
                                    Media: mic {independent.mediaDiagnostics.browserPcmSamples ?? 0} mẫu · giữ trước ACK {independent.mediaDiagnostics.pcmHeldBeforeConfirmation ?? 0} · RTP gửi {independent.mediaDiagnostics.relayRtpSent ?? 0} (lỗi {independent.mediaDiagnostics.relayRtpSendErrors ?? 0}) · relay RX {independent.mediaDiagnostics.relayAudio ?? 0} · SRTP OK/lỗi {independent.mediaDiagnostics.srtpAuthenticated ?? 0}/{independent.mediaDiagnostics.srtpRejected ?? 0} (auth {independent.mediaDiagnostics.srtpAuthFailures ?? 0}, replay {independent.mediaDiagnostics.srtpReplayRejected ?? 0}) · Opus/loa web {independent.mediaDiagnostics.opusDecoded ?? 0}/{independent.mediaDiagnostics.deliveredToBrowser ?? 0} · RTCP {independent.mediaDiagnostics.rtcpParsed ?? 0}/{independent.mediaDiagnostics.srtcpRejected ?? 0}
                                </small>
                            )}
                            <details className="live-details" open={mode === "zalo" || zalo === "connecting" || zalo === "online" || Boolean(qr)}>
                                <summary>Kết nối tài khoản Zalo · thử nghiệm</summary>
                                <p>
                                    Đăng nhập bằng QR chỉ khi bạn muốn thử tài khoản thật. Cookie chỉ giữ trong bộ nhớ
                                    server. Mic, loa và các nút điều khiển nằm trong trình duyệt. Engine độc lập đang được xây;
                                    chưa xác minh đàm thoại Zalo thật.
                                </p>
                                <div className="live-actions">
                                    <button
                                        className="outline-button"
                                        disabled={zalo === "connecting"}
                                        onClick={() =>
                                            action(() => rpc(zalo === "online" ? "zalo-logout" : "zalo-login"))
                                        }
                                    >
                                        {zalo === "online"
                                            ? "Ngắt tài khoản"
                                            : zalo === "connecting"
                                              ? "Đang lấy QR…"
                                              : "Đăng nhập QR"}
                                    </button>
                                    {zalo === "disconnected" && <button className="outline-button" onClick={() => action(() => rpc("zalo-reconnect"))}>Kết nối lại sự kiện</button>}
                                    <span>{zalo === "online" ? "Đang nhận sự kiện Zalo" : zalo}</span>
                                </div>
                                {zalo === "online" && (
                                    <div className="outgoing-call-test" data-testid="outgoing-call-test">
                                        <label className="field-label" htmlFor="outgoing-friend">Gọi đi · thử nghiệm audio</label>
                                        <div className="outgoing-call-controls">
                                            <select id="outgoing-friend" value={peer} onChange={event => setPeer(event.target.value)} disabled={busy || friendsBusy}>
                                                <option value="">{friendsLoaded ? "Chọn bạn bè" : "Tải danh sách bạn bè trước"}</option>
                                                {friends.map(friend => <option key={friend.id} value={friend.id}>{friend.name}</option>)}
                                            </select>
                                            <button className="outline-button" disabled={busy || friendsBusy || !peer || !friendsLoaded} onClick={tryOutgoingCall}>
                                                {friendsBusy ? "Đang xử lý…" : "Chuẩn bị gọi đi (tự kết nối caller relay)"}
                                            </button>
                                            <button className="outline-button" data-testid="outgoing-invite" disabled={busy || friendsBusy || !peer || !friendsLoaded || !independent.outgoingRelayRegistered || independent.outgoingStage !== "relay-registered" || (active && (mode !== "zalo" || input !== "mic"))} onClick={sendOutgoingInvite}>
                                                {friendsBusy ? "Đang xử lý…" : "Gọi bạn (gửi /request)"}
                                            </button>
                                            <button className="outline-button" disabled={busy || friendsBusy} onClick={loadFriends}>
                                                {friendsBusy ? "Đang tải…" : friendsLoaded ? "Tải lại bạn bè" : "Tải bạn bè"}
                                            </button>
                                        </div>
                                        <p className="live-gate">Thứ tự gọi đi: chọn bạn → “Chuẩn bị gọi đi” (gửi `/requestcall` và tự đăng ký caller relay) → “Gọi bạn”. Nút gọi tự chọn mode Zalo, xin quyền mic, mở audio WebRTC rồi gửi `/request`. Không bấm relay cuộc gọi đến cho luồng outgoing. Bạn bè chỉ đổ chuông sau khi `/request` được gửi; mic RTP chỉ mở sau answer/ACK và media checks.</p>
                                    </div>
                                )}
                                {qr && <img className="qr-image" alt="Mã QR đăng nhập Zalo" src={qr} />}
                                <p className="live-gate">Engine độc lập chưa hoàn thiện media. Nút nhận chỉ bật khi có đường nghe/nói thực sự.</p>
                            </details>
                        </section>
                        <section className="panel log-panel">
                            <div className="panel-title">
                                <h2>Nhật ký phiên</h2>
                                <button onClick={() => setLogs([])}>Xóa</button>
                            </div>
                            <div className="event-log" aria-live="polite">
                                {!logs.length && <p className="empty-log">Sự kiện kết nối sẽ xuất hiện tại đây.</p>}
                                {logs.map((item, index) => (
                                    <div
                                        className={item.kind === "error" ? "log-error" : ""}
                                        key={`${item.time}-${index}`}
                                    >
                                        <time>{item.time}</time>
                                        <span>{item.message}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>
                    <footer>
                        <span>
                            <span className="tiny-dot" /> LOCAL PROTOTYPE · NO CALLS IN AUDIO TESTS
                        </span>
                        <span>React / WebRTC / CoreAudio</span>
                    </footer>
                </div>
            </main>
        </div>
    );
}
createRoot(document.getElementById("root")).render(<App />);
