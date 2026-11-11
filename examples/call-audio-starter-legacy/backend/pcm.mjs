export const RATE = 48000;
export const FRAMES = 480;
export class PcmQueue {
    constructor(maxSamples = RATE / 2) {
        this.samples = [];
        this.length = 0;
        this.maxSamples = maxSamples;
        this.dropped = 0;
    }
    push(samples) {
        const copy = new Int16Array(samples);
        this.samples.push(copy);
        this.length += copy.length;
        while (this.length > this.maxSamples && this.samples.length) {
            const old = this.samples.shift();
            this.length -= old.length;
            this.dropped += old.length;
        }
    }
    read(count) {
        const result = new Int16Array(count);
        let offset = 0;
        while (offset < count && this.samples.length) {
            const first = this.samples[0];
            const take = Math.min(count - offset, first.length);
            result.set(first.subarray(0, take), offset);
            offset += take;
            this.length -= take;
            if (take === first.length) this.samples.shift();
            else this.samples[0] = first.subarray(take);
        }
        return result;
    }
}
export function toMono48k(data) {
    const channels = data.channelCount || 1;
    const frames = Math.floor(data.samples.length / channels);
    const ratio = data.sampleRate / RATE;
    const result = new Int16Array(Math.round(frames / ratio));
    for (let i = 0; i < result.length; i++) {
        const position = Math.min(frames - 1, i * ratio),
            left = Math.floor(position),
            right = Math.min(frames - 1, left + 1);
        let a = 0,
            b = 0;
        for (let c = 0; c < channels; c++) {
            a += data.samples[left * channels + c];
            b += data.samples[right * channels + c];
        }
        result[i] = Math.round((a + (b - a) * (position - left)) / channels);
    }
    return result;
}
export function rms(samples) {
    let energy = 0;
    for (const x of samples) energy += (x / 32768) ** 2;
    return samples.length ? Math.sqrt(energy / samples.length) : 0;
}
