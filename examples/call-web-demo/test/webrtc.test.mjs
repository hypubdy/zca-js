import { test } from "node:test";
import assert from "node:assert/strict";
import wrtc from "@roamhq/wrtc";
import { MediaSession, waitIce } from "../media.mjs";
import { rms } from "../pcm.mjs";

test(
    "real ICE/DTLS/Opus loopback returns browser-side synthetic audio through server PCM",
    { timeout: 20000 },
    async () => {
        const remote = new MediaSession({ mode: "echo" });
        let pc = new wrtc.RTCPeerConnection({ iceServers: [] });
        let source = new wrtc.nonstandard.RTCAudioSource();
        let track = source.createTrack();
        pc.addTrack(track, new wrtc.MediaStream([track]));
        let sink,
            receivedFrames = 0,
            loudFrames = 0,
            sample = 0;
        pc.ontrack = (event) => {
            sink = new wrtc.nonstandard.RTCAudioSink(event.track);
            sink.ondata = (data) => {
                receivedFrames++;
                if (rms(data.samples) > 0.02) loudFrames++;
            };
        };
        const timer = setInterval(() => {
            const samples = new Int16Array(480);
            for (let i = 0; i < samples.length; i++)
                samples[i] = 3276 * Math.sin((2 * Math.PI * 440 * sample++) / 48000);
            source.onData({ samples, sampleRate: 48000, channelCount: 1, numberOfFrames: 480 });
        }, 10);
        try {
            await pc.setLocalDescription(await pc.createOffer());
            await waitIce(pc);
            await pc.setRemoteDescription(await remote.answer(pc.localDescription));
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline && loudFrames < 50) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(pc.connectionState, "connected");
            assert.ok(receivedFrames > 50);
            assert.ok(loudFrames >= 50, `Only ${loudFrames} frames contained the test signal`);
            assert.ok(remote.stats.inputSamples > 24000);
        } finally {
            clearInterval(timer);
            if (sink) {
                sink.ondata = null;
                sink.stop();
            }
            pc.ontrack = null;
            track.stop();
            pc.close();
            remote.close();
            sink = null;
            track = null;
            source = null;
            pc = null;
            global.gc?.();
            await new Promise((resolve) => setTimeout(resolve, 200));
            global.gc?.();
        }
    },
);
