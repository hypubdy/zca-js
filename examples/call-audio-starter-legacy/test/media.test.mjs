import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmQueue, toMono48k, rms } from "../backend/pcm.mjs";
import { parseRtpPacket, RtpAudioSender, SrtpRtpContext } from "../dist/call-engine/index.js";
import { parseZrtcIncomingOffer, buildZrtcAcceptedAnswer } from "../dist/call-engine/negotiation.js";

test("PCM queue bounds latency and resamples stereo input to 48 kHz mono", () => {
    const queue = new PcmQueue(4);
    queue.push(Int16Array.from([100, -100, 200, -200, 300, -300]));
    assert.ok(queue.dropped > 0);
    assert.equal(queue.read(4).length, 4);
    const mono = toMono48k({ samples: Int16Array.from([1000, -1000, 2000, -2000]), sampleRate: 48000, channelCount: 2 });
    assert.deepEqual([...mono], [0, 0]);
    assert.equal(rms(mono), 0);
});

test("RTP audio packet round-trips through SRTP authenticate/decrypt", () => {
    const key = Buffer.alloc(30, 7);
    const sender = new RtpAudioSender({ ssrc: 77, payloadType: 111, clockRate: 48000, timestampStep: 960, initialSequenceNumber: 5 });
    const clear = sender.packet(Uint8Array.from([1, 2, 3, 4]));
    const tx = new SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "send", ssrc: 77, initialRoc: 0, initialSequenceNumber: 5 });
    const rx = new SrtpRtpContext({ masterKeySalt: key, profile: 1, direction: "receive", ssrc: 77, initialRoc: 0, initialSequenceNumber: 5 });
    const encrypted = tx.protect(clear);
    const plain = rx.unprotect(encrypted);
    assert.deepEqual(Buffer.from(plain), Buffer.from(clear));
    assert.deepEqual(Buffer.from(parseRtpPacket(plain).payload), Buffer.from([1, 2, 3, 4]));
    tx.destroy(); rx.destroy(); key.fill(0);
});

test("ZRTC incoming offer is parsed and answer preserves the supported audio codec", () => {
    const offerPayload = {
        uidFrom: "1001", uidTo: "1002", uidN: "1001", ts: "1700000000",
        params: JSON.stringify({ id: 123, sessId: "test-session", rtpIP: "127.0.0.1:5000",
            rtcpIP: "127.0.0.1:5000", codec: "[{\"name\":\"opus\",\"payload\":111,\"frmPtime\":20,\"dynamicFptime\":0}]",
            extendData: "{\"packetMode\":2,\"srtpMode\":1,\"srtcp\":0}", zrtc_config: { packetMode: 2, srtpMode: 1 } }),
    };
    const offer = parseZrtcIncomingOffer(offerPayload);
    assert.equal(offer.callId, 123);
    assert.equal(offer.codecs[0].name, "opus");
    const answer = buildZrtcAcceptedAnswer({ offer, codecs: [offer.codecs[0]], rtpAddress: "127.0.0.1:6000", rtcpAddress: "127.0.0.1:6000", capabilities: { packetMode: 2, srtpMode: 1, srtcp: 0 } });
    assert.equal(answer.status, 0);
    assert.match(answer.codec, /opus/i);
});
