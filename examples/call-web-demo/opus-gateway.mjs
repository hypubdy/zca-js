import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OpusScript = require("opusscript");
const SUPPORTED = new Set(["16000/1", "48000/2"]);
const FRAME_MS = new Set([10, 20, 40, 60]);

function makeDecimator() {
    const taps = 63;
    const midpoint = (taps - 1) / 2;
    const cutoff = 1 / 6;
    const weights = new Float64Array(taps);
    let total = 0;
    for (let i = 0; i < taps; i++) {
        const x = i - midpoint;
        const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * cutoff * x) / (2 * Math.PI * cutoff * x);
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
        weights[i] = 2 * cutoff * sinc * window;
        total += weights[i];
    }
    for (let i = 0; i < taps; i++) weights[i] /= total;
    return weights;
}
const DECIMATOR = makeDecimator();

/** Select only codec variants traced in the native audio receive path. */
export function selectNativeOpusCodec(codecs) {
    for (const codec of codecs || []) {
        const match = /^opus\/(\d+)\/(\d+)$/i.exec(codec.name || "");
        if (!match) continue;
        const rate = Number(match[1]);
        const channels = Number(match[2]);
        if (!SUPPORTED.has(`${rate}/${channels}`)) continue;
        const frameMs = FRAME_MS.has(codec.frmPtime) ? codec.frmPtime : 20;
        return { name: codec.name, payloadType: codec.payload, sampleRate: rate, channels, frameMs };
    }
    throw new Error("Offer không có Opus variant được xác nhận (opus/16000/1 hoặc opus/48000/2)");
}

function asPcmBuffer(samples, channels) {
    if (!(samples instanceof Int16Array) || samples.length === 0 || samples.length % channels !== 0)
        throw new TypeError("PCM must be a nonempty interleaved Int16Array");
    const buffer = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], i * 2);
    return buffer;
}

function fromPcmBuffer(buffer) {
    if (buffer.length % 2 !== 0) throw new Error("Opus decoder returned odd-length PCM bytes");
    const samples = new Int16Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2);
    return samples;
}

/** Independent libopus WASM encoder/decoder. It does not touch ZaloCall. */
export class ZrtcOpusGateway {
    constructor(codec) {
        if (!SUPPORTED.has(`${codec.sampleRate}/${codec.channels}`)) throw new RangeError("Unsupported native Opus format");
        if (!Number.isInteger(codec.payloadType) || codec.payloadType < 0 || codec.payloadType > 127)
            throw new RangeError("Invalid negotiated Opus payload type");
        this.codec = codec;
        this.frameSamples = codec.sampleRate * codec.frameMs / 1000;
        this.opus = new OpusScript(codec.sampleRate, codec.channels, OpusScript.Application.VOIP, { wasm: true });
        this.pending = new Int16Array(0);
        this.filter = new Float64Array(DECIMATOR.length);
        this.filterIndex = 0;
        this.decimationPhase = 0;
        this.previousUpsample = 0;
        this.closed = false;
    }
    encodeFrame(pcm) {
        if (this.closed) throw new Error("Opus gateway is closed");
        if (!(pcm instanceof Int16Array) || pcm.length !== this.frameSamples * this.codec.channels)
            throw new RangeError(`Expected ${this.frameSamples * this.codec.channels} interleaved PCM samples`);
        return Uint8Array.from(this.opus.encode(asPcmBuffer(pcm, this.codec.channels), this.frameSamples));
    }
    decodePacket(packet) {
        if (this.closed) throw new Error("Opus gateway is closed");
        if (!(packet instanceof Uint8Array) || packet.length === 0 || packet.length > 1275)
            throw new RangeError("Invalid Opus packet length");
        return fromPcmBuffer(this.opus.decode(Buffer.from(packet)));
    }
    /**
     * Convert browser 48 kHz mono PCM into negotiated Opus frames. The 16 kHz
     * path uses a stateful windowed-sinc decimator to suppress aliasing; output
     * is frame aligned and may be empty until enough samples arrive.
     */
    pushBrowserPcm48k(mono48k) {
        if (this.closed) throw new Error("Opus gateway is closed");
        if (!(mono48k instanceof Int16Array)) throw new TypeError("Browser PCM must be Int16Array");
        const converted = this.codec.sampleRate === 48000 ? mono48k : this.decimate48to16(mono48k);
        let interleaved;
        if (this.codec.channels === 1) interleaved = converted;
        else {
            interleaved = new Int16Array(converted.length * 2);
            for (let i = 0; i < converted.length; i++) interleaved[i * 2] = interleaved[i * 2 + 1] = converted[i];
        }
        if (interleaved.length) {
            const merged = new Int16Array(this.pending.length + interleaved.length);
            merged.set(this.pending); merged.set(interleaved, this.pending.length); this.pending = merged;
        }
        const frames = [];
        const frameLength = this.frameSamples * this.codec.channels;
        while (this.pending.length >= frameLength) {
            frames.push(this.encodeFrame(this.pending.subarray(0, frameLength)));
            this.pending = this.pending.slice(frameLength);
        }
        return frames;
    }
    decimate48to16(input) {
        const output = new Int16Array(Math.ceil(input.length / 3));
        let used = 0;
        for (const sample of input) {
            this.filter[this.filterIndex] = sample;
            this.filterIndex = (this.filterIndex + 1) % this.filter.length;
            this.decimationPhase = (this.decimationPhase + 1) % 3;
            if (this.decimationPhase !== 0) continue;
            let value = 0;
            for (let tap = 0; tap < DECIMATOR.length; tap++) {
                const index = (this.filterIndex - 1 - tap + this.filter.length) % this.filter.length;
                value += this.filter[index] * DECIMATOR[tap];
            }
            output[used++] = Math.max(-32768, Math.min(32767, Math.round(value)));
        }
        return output.slice(0, used);
    }
    /** Decode a Zalo Opus frame into browser-compatible 48 kHz mono PCM. */
    decodeToBrowserPcm48k(packet) {
        const native = this.decodePacket(packet);
        const channels = this.codec.channels;
        const mono = channels === 1 ? native : (() => {
            const result = new Int16Array(native.length / channels);
            for (let i = 0; i < result.length; i++) {
                let sum = 0;
                for (let c = 0; c < channels; c++) sum += native[i * channels + c];
                result[i] = Math.round(sum / channels);
            }
            return result;
        })();
        if (this.codec.sampleRate === 48000) return mono;
        const output = new Int16Array(mono.length * 3);
        let previous = this.previousUpsample;
        for (let i = 0; i < mono.length; i++) {
            const current = mono[i];
            output[i * 3] = Math.round(previous + (current - previous) / 3);
            output[i * 3 + 1] = Math.round(previous + ((current - previous) * 2) / 3);
            output[i * 3 + 2] = current;
            previous = current;
        }
        this.previousUpsample = previous;
        return output;
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.opus.delete();
        this.opus = null;
        this.pending = new Int16Array(0);
        this.filter.fill(0);
    }
}
