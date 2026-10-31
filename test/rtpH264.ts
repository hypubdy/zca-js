import { describe, expect, test } from "bun:test";
import { H264RtpDepacketizer, H264RtpPacketizer, parseRtpPacket, splitH264Nals } from "../src/call/index.js";

describe("H264 RTP transport", () => {
    test("round-trips Annex-B access unit through single-NAL and FU-A packets", () => {
        const sps = Uint8Array.from([0x67, 0x42, 0x00, 0x1f]);
        const idr = Uint8Array.from({length: 700}, (_, i) => i === 0 ? 0x65 : i & 0xff);
        const frame = Uint8Array.from([0,0,0,1,...sps,0,0,1,...idr]);
        expect(splitH264Nals(frame).map(n => n.length)).toEqual([sps.length, idr.length]);
        const packetizer = new H264RtpPacketizer({payloadType: 97, ssrc: 0x12345678, initialSequenceNumber: 0xffff, maxPacketSize: 256});
        const packets = packetizer.packetize(frame, 90000);
        expect(packets.length).toBeGreaterThan(2);
        expect(parseRtpPacket(packets[0]).payload[0] & 0x1f).toBe(7);
        expect(parseRtpPacket(packets[1]).payload[0] & 0x1f).toBe(28);
        expect(parseRtpPacket(packets.at(-1)!).marker).toBe(true);
        const depacketizer = new H264RtpDepacketizer();
        let result: ReturnType<H264RtpDepacketizer["push"]> = null;
        for (const packet of packets) result = depacketizer.push(packet);
        expect(result?.timestamp).toBe(90000);
        expect(result?.keyFrame).toBe(true);
        expect(result?.data).toEqual(Uint8Array.from([0,0,0,1,...sps,0,0,0,1,...idr]));
    });
    test("accepts AVCC input and detects non-key frames", () => {
        const nals = [Uint8Array.from([0x41, 1, 2]), Uint8Array.from([0x61, 3])];
        const avcc = new Uint8Array(4+nals[0].length+4+nals[1].length); let at=0;
        for (const nal of nals) { new DataView(avcc.buffer).setUint32(at,nal.length,false); at+=4; avcc.set(nal,at); at+=nal.length; }
        expect(splitH264Nals(avcc).map(n=>Array.from(n))).toEqual(nals.map(n=>Array.from(n)));
        const packets = new H264RtpPacketizer({payloadType: 97, ssrc: 2}).packetize(avcc, 10);
        const dep = new H264RtpDepacketizer(); let result = null;
        for (const packet of packets) result = dep.push(packet);
        expect(result?.keyFrame).toBe(false);
    });
    test("native packetMode 1 preserves Annex-B bytes instead of emitting RFC 6184 NAL payloads", () => {
        const frame = Uint8Array.from([0,0,0,1,0x67,0x42,0,0x1f,0,0,0,1,0x65,...Array.from({length:700},(_,i)=>i&255)]);
        const packets = new H264RtpPacketizer({payloadType:97,ssrc:9,initialSequenceNumber:100,maxPacketSize:256,packetization:"zrtp"}).packetize(frame,90000);
        expect(packets.length).toBeGreaterThan(2);
        expect(Array.from(parseRtpPacket(packets[0]).payload.subarray(0,4))).toEqual([0,0,0,1]);
        expect(parseRtpPacket(packets.at(-1)!).marker).toBe(true);
        const payloads=packets.map(packet=>parseRtpPacket(packet).payload);
        const restored=Uint8Array.from(payloads.flatMap(payload=>Array.from(payload)));
        expect(restored).toEqual(frame);
    });
});

test("VideoRtpBridge round-trips H264 over independent SRTP state", async () => {
    const { SrtpRtpContext } = await import("../src/call/index.js");
    const masterKeySalt = Buffer.from("e1f97a0d3e018be0d64fa32c06de41390ec675ad498afeebb6960b3aabe6", "hex");
    for (const packetMode of [1, 2]) {
    const localSsrc = 0x12345678, remoteSsrc = 0x87654321;
    const sent: Uint8Array[] = [], frames: unknown[] = [];
    const senderCrypto = new SrtpRtpContext({masterKeySalt, profile:1, direction:"send", ssrc:localSsrc, initialRoc:0, initialSequenceNumber:300});
    const receiverCrypto = new SrtpRtpContext({masterKeySalt, profile:1, direction:"receive", ssrc:localSsrc, initialRoc:0, initialSequenceNumber:300});
    const sender = new (await import("../src/call/index.js")).VideoRtpBridge({
        relay:{sendVideo:packet=>sent.push(Uint8Array.from(packet))}, codec:"h264", payloadType:97, packetMode,
        extensions: true, localSsrc, remoteSsrc, initialSequenceNumber:300, protect:senderCrypto,
        unprotect:new SrtpRtpContext({masterKeySalt, profile:1, direction:"receive", ssrc:remoteSsrc, initialRoc:0, initialSequenceNumber:0}),
        onFrame:frame=>frames.push(frame), maxPacketSize:256,
    });
    const receiver = new (await import("../src/call/index.js")).VideoRtpBridge({
        relay:{sendVideo:()=>{}}, codec:"h264", payloadType:97, packetMode, localSsrc:remoteSsrc, remoteSsrc:localSsrc,
        initialSequenceNumber:400, protect:new SrtpRtpContext({masterKeySalt, profile:1, direction:"send", ssrc:remoteSsrc, initialRoc:0, initialSequenceNumber:400}),
        unprotect:receiverCrypto, onFrame:frame=>frames.push(frame), maxPacketSize:256,
    });
    sender.setConfirmed(true); receiver.setConfirmed(true);
    const nals = Uint8Array.from([0,0,0,1,0x67,0x42,0,0x1f,0,0,0,1,0x65,...Array.from({length:700},(_,i)=>i&255)]);
    const count = sender.sendFrame(nals, 90000);
    expect(count).toBeGreaterThan(1); expect(sent).toHaveLength(count);
    for (const packet of sent) receiver.receiveRtp(packet);
    // Native raw mode completes an access unit when the next timestamp starts.
    sender.sendFrame(Uint8Array.from([0,0,1,0x41,...Array.from({length:12},(_,i)=>i&255)]), 99000);
    for (const packet of sent.slice(count)) receiver.receiveRtp(packet);
    expect(frames).toHaveLength(1);
    expect(receiver.observedExtensionProfiles).toEqual({ "0xbede": sent.length });
    expect(receiver.observedExtensionElements).toEqual({ "13:7": sent.length, "14:7": sent.length });
    expect((frames[0] as { keyFrame: boolean }).keyFrame).toBe(true);
    expect((frames[0] as { data: Uint8Array }).data).toEqual(nals);
    sender.close(); receiver.close();
    }
});

test("raw H264 assembly ignores auxiliary payload types sharing the SSRC", async () => {
    const { VideoRtpBridge } = await import("../src/call/index.js");
    const identity = { protect: (packet: Uint8Array) => packet, unprotect: (packet: Uint8Array) => packet, destroy() {} };
    const frames: { data: Uint8Array; timestamp: number; keyFrame: boolean }[] = [];
    const bridge = new VideoRtpBridge({
        relay: { sendVideo() {} }, codec: "h264", payloadType: 97, packetMode: 2,
        localSsrc: 1, remoteSsrc: 2, initialSequenceNumber: 1,
        protect: identity as never, unprotect: identity as never,
        receivePayloadTypes: [97, 98], onFrame: frame => frames.push(frame),
    });
    bridge.setConfirmed(true);
    const rtp = (payloadType: number, sequence: number, timestamp: number, marker: boolean, payload: number[]) => {
        const packet = new Uint8Array(12 + payload.length);
        packet[0] = 0x80; packet[1] = payloadType | (marker ? 0x80 : 0);
        new DataView(packet.buffer).setUint16(2, sequence, false);
        new DataView(packet.buffer).setUint32(4, timestamp, false);
        new DataView(packet.buffer).setUint32(8, 2, false);
        packet.set(payload, 12);
        return packet;
    };
    const sps = [0x67, 0x42, 0x00, 0x1f, ...Array(8).fill(0)];
    const idr = [0x65, 1, 2, 3, ...Array(8).fill(0)];
    // AU starts on PT97; a PT98 packet arrives in the same SSRC/sequence space.
    expect(bridge.receiveRtp(rtp(97, 10, 90000, false, [0, 0, 0, 1, ...sps]))).toBe(false);
    expect(bridge.receiveRtp(rtp(98, 11, 90000, false, [0xde, 0xad, 0xbe, 0xef, ...Array(10).fill(0)]))).toBe(false);
    expect(bridge.receiveRtp(rtp(97, 12, 90000, true, [0, 0, 1, ...idr]))).toBe(false);
    // The next timestamp finalizes the first access unit.
    expect(bridge.receiveRtp(rtp(97, 13, 99000, true, [0, 0, 1, 0x41, 9, ...Array(10).fill(0)]))).toBe(true);
    expect(bridge.auxiliaryPackets).toBe(1);
    expect(bridge.incompleteAccessUnits).toBe(0);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].data)).toEqual([0, 0, 0, 1, ...sps, 0, 0, 1, ...idr]);
    expect(frames[0].keyFrame).toBe(true);
    // A later timestamp flushes the second AU.
    expect(bridge.receiveRtp(rtp(97, 14, 108000, true, [0, 0, 1, 0x41, 1, ...Array(10).fill(0)]))).toBe(true);
    expect(frames).toHaveLength(2);
    bridge.close();
});
