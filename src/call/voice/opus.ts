import OpusScript from "opusscript";
import type { ZrtcAudioCodec } from "../negotiation.js";

/** Codec variants traced in the native receive path (PT112 16k mono, PT113 48k stereo). */
const SUPPORTED = new Set(["16000/1", "48000/2"]);
/** Native Utility::isFrameTimeValid accepts 20..120 ms in 20 ms steps; we pace 20/40/60. */
const FRAME_MS = new Set([20, 40, 60]);

export type SelectedOpusCodec = {
    name: string;
    payloadType: number;
    sampleRate: 16000 | 48000;
    channels: 1 | 2;
    frameMs: number;
    /** The negotiated codec item, echoed back in signaling. */
    item: ZrtcAudioCodec;
};

/** Native callers offer this codec for one-to-one audio. */
export const DEFAULT_OUTGOING_CODEC: ZrtcAudioCodec = Object.freeze({ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 });

export function selectOpusCodec(codecs: readonly ZrtcAudioCodec[]): SelectedOpusCodec | null {
    for (const codec of codecs) {
        const match = /^opus\/(\d+)\/(\d+)$/i.exec(codec.name || "");
        if (!match) continue;
        const key = `${match[1]}/${match[2]}`;
        if (!SUPPORTED.has(key)) continue;
        if (!Number.isInteger(codec.payload) || codec.payload < 0 || codec.payload > 127) continue;
        return {
            name: codec.name,
            payloadType: codec.payload,
            sampleRate: Number(match[1]) as 16000 | 48000,
            channels: Number(match[2]) as 1 | 2,
            frameMs: FRAME_MS.has(codec.frmPtime) ? codec.frmPtime : 20,
            item: { name: codec.name, payload: codec.payload, frmPtime: codec.frmPtime, dynamicFptime: codec.dynamicFptime },
        };
    }
    return null;
}

function makeDecimator(): Float64Array {
    const taps = 63, midpoint = (taps - 1) / 2, cutoff = 1 / 6;
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

/**
 * libopus (WASM, via opusscript) encoder/decoder for one call, plus the 48 kHz
 * mono ⇄ codec-format conversion. Encoding is frame-based: `encode48k`
 * expects exactly one frame worth of 48 kHz mono samples.
 */
export class OpusCodec {
    readonly frameSamples48k: number;
    readonly frameSamples: number;
    private opus: OpusScript | null;
    private readonly filter = new Float64Array(DECIMATOR.length);
    private filterIndex = 0;
    private phase = 0;
    private previousUpsample = 0;

    constructor(readonly codec: SelectedOpusCodec) {
        this.frameSamples = codec.sampleRate * codec.frameMs / 1000;
        this.frameSamples48k = 48 * codec.frameMs;
        this.opus = new OpusScript(codec.sampleRate, codec.channels, OpusScript.Application.VOIP, { wasm: true });
    }

    /** Encode one frame of 48 kHz mono PCM into one Opus packet in the negotiated format. */
    encode48k(mono48k: Int16Array): Uint8Array {
        if (!this.opus) throw new Error("Opus codec is closed");
        if (mono48k.length !== this.frameSamples48k) throw new RangeError(`Expected ${this.frameSamples48k} samples`);
        const converted = this.codec.sampleRate === 48000 ? mono48k : this.decimate(mono48k);
        const channels = this.codec.channels;
        const pcm = Buffer.allocUnsafe(this.frameSamples * channels * 2);
        for (let i = 0; i < this.frameSamples; i++) {
            const sample = converted[i] ?? 0;
            for (let c = 0; c < channels; c++) pcm.writeInt16LE(sample, (i * channels + c) * 2);
        }
        return Uint8Array.from(this.opus.encode(pcm, this.frameSamples));
    }

    /** Decode one Opus packet to 48 kHz mono PCM. */
    decodeTo48k(packet: Uint8Array): Int16Array {
        if (!this.opus) throw new Error("Opus codec is closed");
        if (!packet.length || packet.length > 1275) throw new RangeError("Invalid Opus packet length");
        const decoded = this.opus.decode(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength));
        const channels = this.codec.channels;
        const frames = Math.floor(decoded.length / 2 / channels);
        const mono = new Int16Array(frames);
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) sum += decoded.readInt16LE((i * channels + c) * 2);
            mono[i] = Math.round(sum / channels);
        }
        if (this.codec.sampleRate === 48000) return mono;
        const out = new Int16Array(mono.length * 3);
        let previous = this.previousUpsample;
        for (let i = 0; i < mono.length; i++) {
            const current = mono[i];
            out[i * 3] = Math.round(previous + (current - previous) / 3);
            out[i * 3 + 1] = Math.round(previous + ((current - previous) * 2) / 3);
            out[i * 3 + 2] = current;
            previous = current;
        }
        this.previousUpsample = previous;
        return out;
    }

    private decimate(input: Int16Array): Int16Array {
        const out = new Int16Array(Math.ceil(input.length / 3));
        let used = 0;
        const length = this.filter.length;
        for (let n = 0; n < input.length; n++) {
            this.filter[this.filterIndex] = input[n];
            this.filterIndex = (this.filterIndex + 1) % length;
            this.phase = (this.phase + 1) % 3;
            if (this.phase !== 0) continue;
            let value = 0;
            for (let tap = 0; tap < DECIMATOR.length; tap++)
                value += this.filter[(this.filterIndex - 1 - tap + length) % length] * DECIMATOR[tap];
            out[used++] = Math.max(-32768, Math.min(32767, Math.round(value)));
        }
        return out.subarray(0, used);
    }

    close(): void {
        if (!this.opus) return;
        try { this.opus.delete(); } catch { /* already freed */ }
        this.opus = null;
    }
}
