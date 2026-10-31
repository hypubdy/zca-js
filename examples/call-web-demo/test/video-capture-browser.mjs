import { chromium } from "playwright-core";
import { build } from "esbuild";

const bundle = await build({
    entryPoints: ["../../packages/call-react/src/index.js"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "VideoCaptureTest",
    write: false,
});
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

try {
    const page = await browser.newPage();
    await page.goto(process.env.SIMPLE_DEMO_URL || "http://localhost:4317/simple", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
        const client = new VideoCaptureTest.ZaloCallClient();
        const frames = [];
        client.socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: raw => frames.push(JSON.parse(raw)) };
        client.update({ independent: { confirmed: true } });
        const capture = await client.startVideoCapture({ width: 320, height: 180, frameRate: 15 });
        await new Promise(resolve => setTimeout(resolve, 1800));
        await client.stopVideoCapture();
        const encoded = frames.find(item => item.action === "video-frame" && item.data.keyFrame);
        if (!encoded) throw new Error("Browser camera did not produce an encoded video frame");
        const bytes = Uint8Array.from(atob(encoded.data.frame), char => char.charCodeAt(0));
        const decoded = await new Promise((resolve, reject) => {
            const decoder = new VideoDecoder({
                output: frame => { const size = [frame.displayWidth, frame.displayHeight]; frame.close(); resolve(size); },
                error: reject,
            });
            decoder.configure({ codec: capture.codec });
            for (const item of frames.slice(0, 6)) {
                const packet = Uint8Array.from(atob(item.data.frame), char => char.charCodeAt(0));
                decoder.decode(new EncodedVideoChunk({ type: item.data.keyFrame ? "key" : "delta", timestamp: item.data.timestamp * 1000 / 90, data: packet }));
            }
            decoder.flush().catch(reject);
            setTimeout(() => reject(new Error(`Browser could not decode its H.264 keyframe: codec=${capture.codec} bytes=${bytes.length} head=${Array.from(bytes.subarray(0, 24), value => value.toString(16).padStart(2, "0")).join("")} state=${decoder.state} queue=${decoder.decodeQueueSize} frames=${frames.length}`)), 3000);
        });
        return { codec: capture.codec, encodedFrames: capture.encodedFrames, sentFrames: capture.sentFrames, decodedWidth: decoded[0], decodedHeight: decoded[1] };
    });
    if (result.sentFrames < 2 || result.decodedWidth < 1 || result.decodedHeight < 1)
        throw new Error(`Browser video capture did not progress: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ success: true, ...result }));
} finally {
    await browser.close();
}
