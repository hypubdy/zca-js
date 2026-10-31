/** Browser camera capture (WebCodecs H.264) and remote frame decoding. */

/**
 * Start camera capture and encode Annex-B H.264 access units for the gateway.
 * Only frames produced after the call is confirmed are sent.
 */
export async function createVideoCapture({
    deps,
    isConfirmed,
    sendVideoFrame,
    socketBufferedAmount,
    emit,
    width = 640,
    height = 360,
    frameRate = 24,
}) {
    if (!deps.VideoEncoder || !deps.MediaStreamTrackProcessor || !deps.mediaDevices?.getUserMedia)
        throw new Error("WebCodecs H.264 capture is not available in this browser");
    const stream = await deps.mediaDevices.getUserMedia({ video: { width, height, frameRate }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        throw new Error("Camera track is unavailable");
    }
    const processor = new deps.MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    const Encoder = deps.VideoEncoder;
    let frameNumber = 0;
    const encoder = new Encoder({
        output: (chunk) => {
            capture.encodedFrames++;
            if (!isConfirmed()) return;
            if (socketBufferedAmount() > 1024 * 1024) {
                capture.forceKeyFrame = true;
                return;
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            const timestamp = Math.max(0, Math.floor(Number(chunk.timestamp || 0) * 90 / 1000)) >>> 0;
            try {
                sendVideoFrame(bytes, timestamp, chunk.type === "key");
                capture.sentFrames++;
            } catch (error) {
                emit("video-error", { message: error?.message || "Video transport failed" });
            }
        },
        error: (error) => emit("video-error", { message: error?.message || "VideoEncoder failed" }),
    });
    const videoConfig = { width, height, bitrate: 800_000, framerate: frameRate, avc: { format: "annexb" } };
    let selectedCodec = "avc1.42E01E";
    if (typeof Encoder.isConfigSupported === "function") {
        for (const candidate of ["avc1.42E01E", "avc1.42001f", "avc1.4D401F"]) {
            try {
                if ((await Encoder.isConfigSupported({ codec: candidate, ...videoConfig })).supported) {
                    selectedCodec = candidate;
                    break;
                }
            } catch {
                /* try the next browser profile */
            }
        }
    }
    encoder.configure({ codec: selectedCodec, ...videoConfig });
    const capture = {
        stream,
        track,
        reader,
        encoder,
        codec: selectedCodec,
        stopped: false,
        encodedFrames: 0,
        sentFrames: 0,
        forceKeyFrame: false,
        requestKeyFrame: () => {
            capture.forceKeyFrame = true;
        },
    };
    capture.task = (async () => {
        try {
            while (!capture.stopped) {
                const item = await reader.read();
                if (item.done) break;
                const frame = item.value;
                try {
                    if (!isConfirmed()) continue;
                    if (encoder.encodeQueueSize > 2) {
                        capture.forceKeyFrame = true;
                        continue;
                    }
                    encoder.encode(frame, { keyFrame: capture.forceKeyFrame || frameNumber++ % 60 === 0 });
                    capture.forceKeyFrame = false;
                } finally {
                    frame.close();
                }
            }
        } catch (error) {
            if (!capture.stopped) emit("video-error", { message: error?.message || "Camera capture failed" });
        }
    })();
    return capture;
}

export async function stopVideoCapture(capture) {
    if (!capture) return;
    capture.stopped = true;
    await capture.reader.cancel().catch(() => {});
    await capture.encoder.flush().catch(() => {});
    capture.encoder.close();
    capture.stream.getTracks().forEach((track) => track.stop());
}

/**
 * WebCodecs decoder for remote H.264/VP8 access units.
 * Recreates the codec after fatal errors and drops reordered frames so one bad
 * relay packet cannot poison the whole call.
 */
export function createVideoDecoder({ deps, stats, onFrame, emit, requestKeyFrame, codec = "avc1.42E01E" }) {
    const Decoder = deps.VideoDecoder;
    if (!Decoder || !deps.EncodedVideoChunk || typeof onFrame !== "function")
        throw new Error("WebCodecs H.264 decoder is not available");
    let decoder;
    let configuredCodec;
    let waitingForKeyFrame = true;
    let lastTimestamp = -1;
    const makeDecoder = (selected) => {
        try {
            decoder?.close();
        } catch {
            /* already closed */
        }
        configuredCodec = selected;
        waitingForKeyFrame = true;
        decoder = new Decoder({
            output: (frame) => {
                stats.decoded++;
                onFrame(frame);
            },
            error: (error) => {
                waitingForKeyFrame = true;
                stats.errors++;
                stats.lastError = String(error?.message || "VideoDecoder failed").slice(0, 160);
                emit("video-error", { message: error?.message || "VideoDecoder failed" });
                requestKeyFrame().catch(() => {});
                try {
                    makeDecoder(configuredCodec);
                } catch {
                    /* keep waiting for a keyframe */
                }
            },
        });
        decoder.configure({ codec: selected });
    };
    makeDecoder(codec);
    return {
        get decoder() {
            return decoder;
        },
        push(data) {
            if (typeof data?.frame !== "string") return;
            const selectedCodec = data.codec === "vp8" ? "vp8" : data.codec === "h264" ? "avc1.42E01E" : configuredCodec;
            if (selectedCodec !== configuredCodec || decoder.state === "closed" || decoder.state === "unconfigured")
                makeDecoder(selectedCodec);
            if (waitingForKeyFrame && !data.keyFrame) {
                requestKeyFrame().catch(() => {});
                return;
            }
            const binary = atob(data.frame);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
            const timestamp = Math.floor(Number(data.timestamp || 0) * 1000 / 90);
            if (lastTimestamp >= 0 && timestamp <= lastTimestamp) return;
            lastTimestamp = timestamp;
            try {
                decoder.decode(new deps.EncodedVideoChunk({ type: data.keyFrame ? "key" : "delta", timestamp, data: bytes }));
                if (data.keyFrame) waitingForKeyFrame = false;
            } catch (error) {
                waitingForKeyFrame = true;
                emit("video-error", { message: error?.message || "VideoDecoder rejected frame" });
                requestKeyFrame().catch(() => {});
                try {
                    if (decoder.state === "closed") makeDecoder(configuredCodec);
                } catch {
                    /* recreate failed; PLI will retry */
                }
            }
        },
        reset() {
            decoder.reset();
            waitingForKeyFrame = true;
            lastTimestamp = -1;
        },
        close() {
            try {
                decoder.close();
            } catch {
                /* already closed */
            }
        },
    };
}
