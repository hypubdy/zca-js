import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmQueue, rms, toMono48k } from "../pcm.mjs";

test("audio queue survives irregular pipe boundaries, pads underflow and bounds latency", () => {
    const queue = new PcmQueue(10);
    queue.push([1, 2, 3]);
    queue.push([4, 5]);
    assert.deepEqual([...queue.read(4)], [1, 2, 3, 4]);
    assert.deepEqual([...queue.read(4)], [5, 0, 0, 0]);
    queue.push([1, 2, 3, 4, 5, 6]);
    queue.push([7, 8, 9, 10, 11, 12]);
    assert.ok(queue.length <= 10);
    assert.equal(queue.dropped, 6);
    assert.deepEqual([...queue.read(6)], [7, 8, 9, 10, 11, 12]);
});
test("stereo anti-phase downmix cancels, native 16k input converts to 48k duration", () => {
    const stereo = new Int16Array(960);
    for (let i = 0; i < 480; i++) {
        stereo[i * 2] = 3000;
        stereo[i * 2 + 1] = -3000;
    }
    assert.equal(rms(toMono48k({ samples: stereo, sampleRate: 48000, channelCount: 2 })), 0);
    const result = toMono48k({ samples: new Int16Array(160).fill(2000), sampleRate: 16000, channelCount: 1 });
    assert.equal(result.length, 480);
    assert.equal(result[479], 2000);
});
