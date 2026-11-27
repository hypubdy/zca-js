/* global location, VideoEncoder, VideoDecoder, EncodedVideoChunk, MediaStreamTrackProcessor */
// Browser video leg: camera → WebCodecs H.264 (Annex-B) → WS /video → zca-js call.writeVideo,
// and call "video" frames → WS /video → WebCodecs decoder → <canvas>.
// Frame format both ways: [flags u8 (bit0 keyframe)][timestamp90k u32 BE][Annex-B access unit].

// 30 fps like native Zalo capture (24 fps looked choppy next to it). Keyframes stay
// every 2 s: Zalo sends no PLI/NACK back, so periodic IDRs are the only loss recovery.
const WIDTH = 640, HEIGHT = 480, FPS = 30, BITRATE = 800_000, KEYFRAME_EVERY = FPS * 2;
const CODECS = ["avc1.42E01E", "avc1.42001f", "avc1.4D401F"]; // Constrained Baseline first

export function videoSupported() {
    return typeof VideoEncoder === "function" && typeof VideoDecoder === "function" && typeof MediaStreamTrackProcessor === "function";
}

/**
 * @param {{ localVideo: HTMLVideoElement, canvas: HTMLCanvasElement, log: (s: string) => void }} ui
 */
export async function startVideo(ui) {
    if (!videoSupported()) throw new Error("Trình duyệt không hỗ trợ WebCodecs H.264 (dùng Chrome/Edge mới)");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/video`);
    ws.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Không mở được WS /video")); });

    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: WIDTH, height: HEIGHT, frameRate: FPS }, audio: false });
    const track = stream.getVideoTracks()[0];
    ui.localVideo.srcObject = stream;
    const state = { stopped: false, forceKey: true, frames: 0, sent: 0, received: 0, decoded: 0, decodeErrors: 0, needKey: true, cameraOn: true };

    // ---- encoder
    const config = { width: WIDTH, height: HEIGHT, bitrate: BITRATE, framerate: FPS, latencyMode: "realtime", avc: { format: "annexb" } };
    let codec = CODECS[0];
    for (const candidate of CODECS) {
        try { if ((await VideoEncoder.isConfigSupported({ codec: candidate, ...config })).supported) { codec = candidate; break; } } catch { /* next */ }
    }
    const encoder = new VideoEncoder({
        output: chunk => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 1024 * 1024) { state.forceKey = true; return; } // congested: skip, resync with IDR
            const out = new Uint8Array(5 + chunk.byteLength);
            out[0] = chunk.type === "key" ? 1 : 0;
            new DataView(out.buffer).setUint32(1, Math.round(chunk.timestamp * 0.09) >>> 0); // µs → 90 kHz
            chunk.copyTo(out.subarray(5));
            ws.send(out);
            state.sent++;
        },
        error: error => ui.log(`encoder error: ${error.message}`),
    });
    encoder.configure({ codec, ...config });
    ui.log(`video encoder ${codec} ${WIDTH}x${HEIGHT}@${FPS}`);

    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    (async () => {
        while (!state.stopped) {
            const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
            if (done) break;
            try {
                if (!state.cameraOn || encoder.encodeQueueSize > 2) { state.forceKey = true; continue; }
                const keyFrame = state.forceKey || state.frames % KEYFRAME_EVERY === 0;
                encoder.encode(frame, { keyFrame });
                state.forceKey = false;
                state.frames++;
            } finally { frame.close(); }
        }
    })();

    // ---- decoder
    const ctx = ui.canvas.getContext("2d");
    let decoder = null;
    const makeDecoder = () => {
        try { decoder?.close(); } catch { /* closed */ }
        decoder = new VideoDecoder({
            output: frame => {
                if (ui.canvas.width !== frame.displayWidth || ui.canvas.height !== frame.displayHeight) {
                    ui.canvas.width = frame.displayWidth; ui.canvas.height = frame.displayHeight;
                }
                ctx.drawImage(frame, 0, 0);
                frame.close();
                state.decoded++;
            },
            error: error => {
                state.decodeErrors++;
                ui.log(`decoder error: ${error.message} → yêu cầu keyframe`);
                state.needKey = true;
                requestKeyFrame();
                setTimeout(makeDecoder, 0);
            },
        });
        // Annex-B input: no `description`, SPS/PPS travel in-band before each IDR.
        decoder.configure({ codec: "avc1.42E01E", optimizeForLatency: true });
    };
    makeDecoder();
    const requestKeyFrame = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pli" })); };

    ws.onmessage = event => {
        if (typeof event.data === "string") {
            try { if (JSON.parse(event.data).type === "keyframe") state.forceKey = true; } catch { /* ignore */ }
            return;
        }
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 6) return;
        const key = (bytes[0] & 1) === 1;
        state.received++;
        if (state.needKey && !key) return;
        if (decoder.state !== "configured") return;
        state.needKey = false;
        const timestamp = new DataView(bytes.buffer).getUint32(1);
        try {
            decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Math.round(timestamp / 0.09), data: bytes.subarray(5) }));
        } catch (error) {
            state.needKey = true;
            ui.log(`decode rejected: ${error.message}`);
            requestKeyFrame();
        }
    };

    return {
        stats: () => ({ encoded: state.frames, sent: state.sent, received: state.received, decoded: state.decoded, decodeErrors: state.decodeErrors }),
        setCamera(on) { state.cameraOn = on; track.enabled = on; if (on) state.forceKey = true; },
        async stop() {
            state.stopped = true;
            await reader.cancel().catch(() => {});
            try { encoder.close(); } catch { /* closed */ }
            try { decoder?.close(); } catch { /* closed */ }
            stream.getTracks().forEach(t => t.stop());
            ui.localVideo.srcObject = null;
            ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
            ws.close();
        },
    };
}
