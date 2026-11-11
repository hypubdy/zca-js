import wrtc from "@roamhq/wrtc";
import { spawn } from "node:child_process";
import { PcmQueue, RATE, FRAMES, toMono48k, rms } from "./pcm.mjs";

export async function waitIce(pc) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", onChange);
            reject(new Error("ICE gathering timeout"));
        }, 8000);
        function onChange() {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timeout);
                pc.removeEventListener("icegatheringstatechange", onChange);
                resolve();
            }
        }
        pc.addEventListener("icegatheringstatechange", onChange);
        onChange();
    });
}

export class MediaSession {
    constructor({ mode = "echo", nativeBinary, inputUid, outputUid, tapBinary, tapPid, relayBridge, iceServers = [], notify = () => {} }) {
        const processTap = mode === "zalo" && Boolean(tapBinary && tapPid);
        if (!["tone", "echo", "virtual", "zalo"].includes(mode)) throw new Error("Unknown audio mode");
        const independentRelay = mode === "zalo" && relayBridge && typeof relayBridge.onMicPcm === "function";
        if ((mode === "virtual" || (mode === "zalo" && !independentRelay)) && (!nativeBinary || (!processTap && !inputUid) || !outputUid))
            throw new Error("Choose both server audio devices");
        if (mode === "zalo" && !independentRelay && !processTap && inputUid === outputUid)
            throw new Error("Zalo mode requires separate RX/TX devices to avoid feedback");
        this.mode = mode;
        this.notify = notify;
        this.queue = new PcmQueue();
        this.closed = false;
        this.stats = {
            mode,
            inputSamples: 0,
            outputSamples: 0,
            inputRms: 0,
            outputRms: 0,
            nativeInputSamples: 0,
            nativeOutputSamples: 0,
            nativeReady: false,
            tapReady: false,
            route: independentRelay ? "browser-webrtc/independent-relay" : processTap ? "process-tap-rx/virtual-tx" : mode,
        };
        this.pc = new wrtc.RTCPeerConnection({ iceServers });
        this.source = new wrtc.nonstandard.RTCAudioSource();
        this.track = this.source.createTrack();
        this.pc.addTrack(this.track, new wrtc.MediaStream([this.track]));
        this.pc.onconnectionstatechange = () => {
            notify("media-state", { state: this.pc.connectionState });
            if (["failed", "closed"].includes(this.pc.connectionState)) this.close();
        };
        this.pc.ontrack = ({ track }) => {
            if (track.kind !== "audio") return;
            this.sink?.stop();
            this.sink = new wrtc.nonstandard.RTCAudioSink(track);
            this.sink.ondata = (data) => {
                if (this.closed) return;
                const mono = toMono48k(data);
                this.stats.inputSamples += mono.length;
                this.stats.inputRms = rms(mono);
                if (this.mode === "echo") this.queue.push(mono);
                if (independentRelay) relayBridge.onMicPcm(mono);
                if (this.native) {
                    // Bound the pipe backlog: do not let delayed audio accumulate indefinitely.
                    if (this.native.stdin.writableLength < RATE / 5 && !this.native.stdin.destroyed) {
                        this.native.stdin.write(Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength));
                        this.stats.nativeOutputSamples += mono.length;
                    }
                }
            };
        };
        if (mode === "virtual" || (mode === "zalo" && !independentRelay)) {
            const args = processTap ? ["--output", outputUid] : ["--input", inputUid, "--output", outputUid];
            if (mode === "virtual") args.push("--allow-loopback");
            this.native = spawn(nativeBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
            this.native.stdin.on("error", (error) => {
                if (!this.closed) notify("native-error", { message: error.message });
            });
            let pending = Buffer.alloc(0),
                stderr = "";
            const consumePcm = (chunk) => {
                pending = Buffer.concat([pending, chunk]);
                const size = pending.length - (pending.length % 2);
                if (!size) return;
                const samples = new Int16Array(size / 2);
                for (let i = 0; i < samples.length; i++) samples[i] = pending.readInt16LE(i * 2);
                pending = Buffer.from(pending.subarray(size));
                this.stats.nativeInputSamples += samples.length;
                this.queue.push(samples);
            };
            if (!processTap) this.native.stdout.on("data", consumePcm);
            else this.native.stdout.resume();
            this.native.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
                const lines = stderr.split("\n");
                stderr = lines.pop().slice(-8000);
                for (const line of lines)
                    if (line) {
                        try {
                            const event = JSON.parse(line);
                            if (event.type === "ready" || event.event === "ready") this.stats.nativeReady = true;
                            notify("native", event);
                        } catch {
                            notify("native-log", { message: line.slice(0, 1000) });
                        }
                    }
            });
            this.native.on("error", (error) => {
                notify("native-error", { message: error.message });
                this.close();
            });
            this.native.on("exit", (code, signal) => {
                if (!this.closed) {
                    notify("native-error", { message: `PCM process exited (${code ?? signal})` });
                    this.close();
                }
            });
            if (processTap) {
                this.tap = spawn(tapBinary, ["--pid", String(tapPid)], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
                this.tap.stdio[3].on("data", consumePcm);
                let status = "";
                this.audioReady = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error("Process tap timeout; verify System Audio Recording permission")), 10000);
                    this.tap.stdout.on("data", chunk => {
                        status += chunk.toString();
                        const lines = status.split("\n"); status = lines.pop().slice(-8000);
                        for (const line of lines) if (line) {
                            try {
                                const event = JSON.parse(line);
                                if (event.type === "ready") { this.stats.tapReady = true; clearTimeout(timeout); resolve(); }
                                if (event.type === "error") { clearTimeout(timeout); reject(new Error(event.message)); }
                                notify("native-tap", { type: event.type, stage: event.stage, message: event.message });
                            } catch (error) { clearTimeout(timeout); reject(error); }
                        }
                    });
                    this.tap.on("error", error => { clearTimeout(timeout); reject(error); });
                    this.tap.on("exit", (code, signal) => {
                        clearTimeout(timeout);
                        if (!this.closed) {
                            const error = new Error(`Process tap exited (${code ?? signal})`);
                            reject(error); notify("native-error", { message: error.message }); this.close();
                        }
                    });
                });
                this.audioReady.catch(() => {});
                this.tap.stderr.on("data", chunk => notify("native-log", { message: chunk.toString().slice(0, 1000) }));
            }
        }
        let position = 0;
        let nextTick = performance.now() + 10;
        const pump = () => {
            if (this.closed) return;
            let catchup = 0;
            const now = performance.now();
            while (now >= nextTick && catchup++ < 3) {
                let samples;
                if (this.mode === "tone") {
                    samples = new Int16Array(FRAMES);
                    for (let i = 0; i < FRAMES; i++)
                        samples[i] = 3276 * Math.sin((2 * Math.PI * 440 * position++) / RATE);
                } else samples = this.queue.read(FRAMES);
                this.stats.outputSamples += samples.length;
                this.stats.outputRms = rms(samples);
                this.source.onData({
                    samples,
                    sampleRate: RATE,
                    bitsPerSample: 16,
                    channelCount: 1,
                    numberOfFrames: FRAMES,
                });
                nextTick += 10;
            }
            if (now - nextTick > 100) nextTick = now + 10;
            this.timer = setTimeout(pump, Math.max(1, nextTick - performance.now()));
        };
        this.timer = setTimeout(pump, 10);
        this.statsTimer = setInterval(
            () =>
                notify("media-stats", {
                    ...this.stats,
                    queuedSamples: this.queue.length,
                    droppedSamples: this.queue.dropped,
                }),
            500,
        );
    }
    async answer(offer) {
        try {
            if (this.audioReady) await this.audioReady;
            if (this.native) {
                const deadline = Date.now() + 10000;
                while (!this.stats.nativeReady && !this.closed && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 20));
                if (this.closed || !this.stats.nativeReady) throw new Error("PCM audio device did not become ready");
            }
            await this.pc.setRemoteDescription(offer);
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            await waitIce(this.pc);
            return this.pc.localDescription;
        } catch (error) {
            this.close();
            throw error;
        }
    }
    pushPcm(samples) {
        if (this.closed) return;
        this.queue.push(samples);
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.timer);
        clearInterval(this.statsTimer);
        if (this.sink) {
            this.sink.ondata = null;
            this.sink.stop();
        }
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.track.stop();
        this.pc.close();
        this.sink = null;
        this.track = null;
        this.source = null;
        this.pc = null;
        if (this.native) {
            this.native.stdin.destroy();
            this.native.kill("SIGTERM");
            const child = this.native;
            const timer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 1500);
            timer.unref();
        }
        if (this.tap) {
            const child = this.tap; child.kill("SIGTERM");
            const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1500); timer.unref();
        }
        this.notify("media-ended", { stats: this.stats });
    }
}
