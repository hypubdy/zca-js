// Independent TX/RX integration: TX 880 Hz -> virtual device; RX 440 Hz -> selected process tap.
import wrtc from "@roamhq/wrtc";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { MediaSession, waitIce } from "../media.mjs";
import { toMono48k } from "../pcm.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = spawn(path.join(root, ".runtime/test-tone"), ["440", "0.05"], { stdio: ["pipe", "pipe", "pipe"] });
const result = { passed: false, timestamp: new Date().toISOString() };
let media, pc, source, track, sink, timer;
try {
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Tone fixture timeout; run test/process-tap.mjs first")), 7000);
        target.stdout.once("data", () => { clearTimeout(timeout); resolve(); }); target.once("error", error => { clearTimeout(timeout); reject(error); });
    });
    media = new MediaSession({ mode: "zalo", nativeBinary: path.join(root, ".runtime/pcm-bridge"),
        outputUid: "MSLoopbackDriverDevice_UID", tapBinary: path.join(root, ".runtime/process-tap"), tapPid: target.pid });
    pc = new wrtc.RTCPeerConnection(); source = new wrtc.nonstandard.RTCAudioSource(); track = source.createTrack();
    pc.addTrack(track, new wrtc.MediaStream([track]));
    const received = []; let count = 0, collect = false;
    pc.ontrack = ({ track }) => {
        sink = new wrtc.nonstandard.RTCAudioSink(track);
        sink.ondata = data => { if (collect && count < 96000) { const samples = toMono48k(data); received.push(samples); count += samples.length; } };
    };
    let sample = 0;
    timer = setInterval(() => {
        const samples = new Int16Array(480);
        for (let i = 0; i < 480; i++) samples[i] = Math.round(1638 * Math.sin(2 * Math.PI * 880 * sample++ / 48000));
        source.onData({ samples, sampleRate: 48000, channelCount: 1, numberOfFrames: 480 });
    }, 10);
    await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc);
    await pc.setRemoteDescription(await media.answer(pc.localDescription));
    target.stdin.write("START\n");
    await new Promise(resolve => setTimeout(resolve, 800)); collect = true;
    await new Promise(resolve => setTimeout(resolve, 2200)); collect = false;
    assert.ok(count >= 72000, `Only ${count} RX samples`);
    const samples = new Int16Array(count); let offset = 0;
    for (const chunk of received) { samples.set(chunk, offset); offset += chunk.length; }
    function amplitude(hz) {
        let re = 0, im = 0;
        for (let i = 0; i < samples.length; i++) { const v = samples[i] / 32768; re += v * Math.cos(2 * Math.PI * hz * i / 48000); im += v * Math.sin(2 * Math.PI * hz * i / 48000); }
        return 2 * Math.hypot(re, im) / samples.length;
    }
    result.samples = count; result.rx440 = amplitude(440); result.tx880Leak = amplitude(880); result.stats = media.stats;
    assert.ok(result.rx440 > 0.015, `Remote tone missing: ${result.rx440}`);
    assert.ok(result.tx880Leak < 0.002, `TX leaked into RX: ${result.tx880Leak}`);
    assert.ok(media.stats.nativeOutputSamples > 48000 && media.stats.nativeInputSamples > 48000);
    result.passed = true;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
    clearInterval(timer); if (target.pid) { target.stdin.write("STOP\n"); target.kill("SIGTERM"); }
    if (sink) { sink.ondata = null; sink.stop(); } if (pc) pc.ontrack = null;
    track?.stop(); pc?.close(); media?.close(); sink = null; track = null; source = null; pc = null; media = null;
    global.gc?.(); await new Promise(resolve => setTimeout(resolve, 300)); global.gc?.();
    await fs.writeFile(path.join(root, ".runtime/tap-gateway-test.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}
