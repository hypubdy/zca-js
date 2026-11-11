/** Audio sample rate used by every public PCM surface (VoiceCall.writeAudio / "audio"). */
export const PCM_RATE = 48000;

/**
 * Bounded FIFO of Int16 samples. When full, the oldest samples are dropped so
 * latency stays bounded instead of growing without limit.
 */
export class PcmRing {
    private chunks: Int16Array[] = [];
    private offset = 0; // read offset into chunks[0]
    private size = 0;
    dropped = 0;
    constructor(readonly maxSamples: number) {
        if (!Number.isInteger(maxSamples) || maxSamples < 1) throw new RangeError("maxSamples must be a positive integer");
    }
    get length(): number { return this.size; }
    push(samples: Int16Array): void {
        if (!samples.length) return;
        let input = samples;
        if (input.length >= this.maxSamples) {
            this.dropped += this.size + input.length - this.maxSamples;
            this.clear();
            input = input.subarray(input.length - this.maxSamples);
        }
        this.chunks.push(Int16Array.from(input));
        this.size += input.length;
        while (this.size > this.maxSamples) {
            const first = this.chunks[0];
            const available = first.length - this.offset;
            const excess = this.size - this.maxSamples;
            if (excess >= available) {
                this.chunks.shift();
                this.offset = 0;
                this.size -= available;
                this.dropped += available;
            } else {
                this.offset += excess;
                this.size -= excess;
                this.dropped += excess;
            }
        }
    }
    /** Read exactly `count` samples, zero-filling when the buffer runs dry. */
    read(count: number): Int16Array {
        const out = new Int16Array(count);
        let written = 0;
        while (written < count && this.chunks.length) {
            const first = this.chunks[0];
            const take = Math.min(count - written, first.length - this.offset);
            out.set(first.subarray(this.offset, this.offset + take), written);
            written += take;
            this.offset += take;
            this.size -= take;
            if (this.offset >= first.length) { this.chunks.shift(); this.offset = 0; }
        }
        return out;
    }
    clear(): void { this.chunks = []; this.offset = 0; this.size = 0; }
}

export function rms(samples: Int16Array): number {
    if (!samples.length) return 0;
    let energy = 0;
    for (let i = 0; i < samples.length; i++) { const x = samples[i] / 32768; energy += x * x; }
    return Math.sqrt(energy / samples.length);
}

/** Exponentially smoothed RMS meter (time constant ≈ 300 ms at 20 ms updates). */
export class RmsMeter {
    value = 0;
    update(samples: Int16Array): void {
        const current = rms(samples);
        this.value = this.value * 0.9 + current * 0.1;
        if (this.value < 1e-9) this.value = 0;
    }
}

/** Convert interleaved PCM at any rate/channel count to 48 kHz mono (linear interpolation). */
export function toMono48k(samples: Int16Array, sampleRate: number, channels = 1): Int16Array {
    const frames = Math.floor(samples.length / channels);
    if (!frames) return new Int16Array(0);
    if (sampleRate === PCM_RATE && channels === 1) return samples;
    const ratio = sampleRate / PCM_RATE;
    const out = new Int16Array(Math.max(1, Math.round(frames / ratio)));
    for (let i = 0; i < out.length; i++) {
        const position = Math.min(frames - 1, i * ratio);
        const left = Math.floor(position);
        const right = Math.min(frames - 1, left + 1);
        let a = 0, b = 0;
        for (let c = 0; c < channels; c++) { a += samples[left * channels + c]; b += samples[right * channels + c]; }
        out[i] = Math.round((a + (b - a) * (position - left)) / channels);
    }
    return out;
}
