// zca-js/call-webrtc: a second wrtc PeerConnection plays the browser. Skipped without @roamhq/wrtc.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let wrtc = null;
try { wrtc = require("@roamhq/wrtc"); } catch { /* optional peer dependency */ }

// @roamhq/wrtc 0.10.0 segfaults in native teardown at normal process exit (seen on
// macOS arm64 even for a bare RTCPeerConnection). An explicit process.exit avoids it.
if (wrtc) after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 50); });

test("core zca-js/call loads without @roamhq/wrtc being required", async () => {
    const core = await import("zca-js/call");
    assert.equal(typeof core.createCallController, "function");
});

test("call-webrtc bridges browser audio ⇄ VoiceCall both ways", { skip: !wrtc && "@roamhq/wrtc not installed" }, async () => {
    const { createWebRtcBridge } = await import("zca-js/call-webrtc");
    // Fake VoiceCall: records writeAudio, emits "audio".
    const call = new EventEmitter();
    call.state = "connected";
    const written = [];
    call.writeAudio = pcm => written.push(pcm);

    const bridge = createWebRtcBridge();
    const states = [];
    bridge.on("state", s => states.push(s));

    const browser = new wrtc.RTCPeerConnection();
    const source = new wrtc.nonstandard.RTCAudioSource();
    const track = source.createTrack();
    browser.addTrack(track, new wrtc.MediaStream([track]));
    let heard = 0, sink = null;
    browser.ontrack = ({ track: remote }) => {
        sink = new wrtc.nonstandard.RTCAudioSink(remote);
        sink.ondata = ({ samples }) => { for (const s of samples) heard = Math.max(heard, Math.abs(s)); };
    };
    await browser.setLocalDescription(await browser.createOffer());
    await new Promise(r => { const check = () => browser.iceGatheringState === "complete" && r(); browser.onicegatheringstatechange = check; check(); setTimeout(r, 3000); });
    const answer = await bridge.accept({ type: "offer", sdp: browser.localDescription.sdp });
    assert.equal(answer.type, "answer");
    await browser.setRemoteDescription(answer);
    bridge.attach(call);

    const tone = new Int16Array(480);
    let t = 0;
    const timer = setInterval(() => {
        for (let i = 0; i < 480; i++) tone[i] = 8000 * Math.sin(2 * Math.PI * 440 * t++ / 48000);
        source.onData({ samples: tone, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
        call.emit("audio", Int16Array.from(tone)); // peer → browser
    }, 10);
    await new Promise(r => setTimeout(r, 2500));
    clearInterval(timer);
    const browserToCall = Math.max(0, ...written.flatMap(pcm => [Math.max(...pcm.map(Math.abs))]));
    assert.ok(states.includes("connected"), `bridge connected (${states})`);
    assert.ok(browserToCall > 1000, `browser mic reached call.writeAudio (peak ${browserToCall})`);
    assert.ok(heard > 1000, `call audio reached browser (peak ${heard})`);

    call.emit("ended", { reason: "remote-hangup", durationMs: 1 });
    assert.equal(call.listenerCount("audio"), 0, "bridge detaches on ended");
    bridge.close(); bridge.close();
    sink?.stop(); track.stop(); browser.close();
});
