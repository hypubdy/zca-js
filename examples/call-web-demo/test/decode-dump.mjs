// Decode one dumped Annex-B keyframe in headless Chrome and report whether it
// produces a visible picture. Used to separate "frames are corrupt" from
// "browser wiring/rendering is broken" after a live call.
//
//   node test/decode-dump.mjs /tmp/zca-video-dump/in-key-1.h264
//   node test/decode-dump.mjs --selftest
import fs from "node:fs";
import { chromium } from "playwright-core";

const arg = process.argv[2];
if (!arg) {
    console.error("usage: node test/decode-dump.mjs <file.h264> | --selftest");
    process.exit(2);
}
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
});
try {
    const page = await browser.newPage();
    await page.goto(process.env.SIMPLE_DEMO_URL || "http://127.0.0.1:4317/simple", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async ({ mode, base64 }) => {
        const bytes = base64
            ? Uint8Array.from(atob(base64), char => char.charCodeAt(0))
            : null;
        const decode = async (codec, data) => {
            const frames = [];
            const decoder = new VideoDecoder({
                output: frame => frames.push(frame),
                error: error => { throw new Error(`decoder: ${error?.message || error}`); },
            });
            decoder.configure({ codec });
            decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
            await decoder.flush();
            decoder.close();
            return frames;
        };
        const measure = frames => {
            if (!frames.length) return { frames: 0 };
            const frame = frames.at(-1);
            const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
            const context = canvas.getContext("2d");
            context.drawImage(frame, 0, 0);
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            let sum = 0, max = 0;
            const pixels = canvas.width * canvas.height;
            for (let index = 0; index < data.length; index += 4) {
                const luma = (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000;
                sum += luma;
                if (luma > max) max = luma;
            }
            const result = { frames: frames.length, width: canvas.width, height: canvas.height,
                meanLuma: Number((sum / pixels).toFixed(2)), maxLuma: Number(max.toFixed(2)) };
            for (const item of frames) item.close();
            return result;
        };
        if (mode === "selftest") {
            // Encode a bright 160x90 frame, then decode it with the same path.
            const canvas = new OffscreenCanvas(160, 90);
            const context = canvas.getContext("2d");
            context.fillStyle = "rgb(200,120,40)";
            context.fillRect(0, 0, 160, 90);
            const chunks = [];
            const encoder = new VideoEncoder({
                output: chunk => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push(data); },
                error: error => { throw new Error(`encoder: ${error?.message || error}`); },
            });
            encoder.configure({ codec: "avc1.42E01E", width: 160, height: 90, bitrate: 400000, framerate: 15, avc: { format: "annexb" } });
            encoder.encode(new VideoFrame(canvas, { timestamp: 0 }), { keyFrame: true });
            await encoder.flush();
            encoder.close();
            const merged = new Uint8Array(chunks.reduce((total, item) => total + item.length, 0));
            let at = 0;
            for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length; }
            const frames = await decode("avc1.42E01E", merged);
            return { mode, ...measure(frames) };
        }
        const frames = await decode("avc1.42E01E", bytes);
        return { mode, bytes: bytes.length, ...measure(frames) };
    }, { mode: arg === "--selftest" ? "selftest" : "file",
        base64: arg === "--selftest" ? "" : fs.readFileSync(arg).toString("base64") });
    if (!result.frames) throw new Error(`no decoded frame: ${JSON.stringify(result)}`);
    if (result.meanLuma < 1) throw new Error(`decoded frame is black: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ success: true, ...result }));
} finally {
    await browser.close();
}
