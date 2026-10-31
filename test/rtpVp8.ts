import { describe, expect, test } from "bun:test";
import { SrtpRtpContext, VideoRtpBridge, Vp8RtpDepacketizer, Vp8RtpPacketizer, parseRtpPacket } from "../src/call/index.js";

const masterKeySalt = Buffer.from("e1f97a0d3e018be0d64fa32c06de41390ec675ad498afeebb6960b3aabe6", "hex");

describe("VP8 RTP frame transport", () => {
    test("packetizes and reassembles a fragmented key frame with RTP sequence wrap", () => {
        const frame=Uint8Array.from({length:700},(_,index)=>index&0xff);
        frame.set([0x00,0x00,0x00,0x9d,0x01,0x2a]);
        const packetizer=new Vp8RtpPacketizer({payloadType:96,ssrc:0x12345678,initialSequenceNumber:0xffff,maxPacketSize:256});
        const packets=packetizer.packetize(frame,0xfedcba98);
        expect(packets.length).toBeGreaterThan(1);
        const parsed=packets.map(packet=>parseRtpPacket(packet));
        expect(parsed[0].sequenceNumber).toBe(0xffff);
        expect(parsed[1].sequenceNumber).toBe(0);
        expect(parsed[0].payload[0]).toBe(0x10);
        expect(parsed.at(-1)!.marker).toBe(true);
        const depacketizer=new Vp8RtpDepacketizer();
        let result=null;
        for(const packet of packets) result=depacketizer.push(packet);
        expect(result).toEqual({data:frame,timestamp:0xfedcba98,keyFrame:true});
    });
    test("parses optional VP8 extension fields and drops a frame with a sequence gap", () => {
        const packetizer=new Vp8RtpPacketizer({payloadType:97,ssrc:5,initialSequenceNumber:10});
        const [first,second]=packetizer.packetize(Uint8Array.from({length:2000},(_,i)=>i===0?1:i&0xff),9000);
        first[12]=0x90; // X=1, S=1, PartID=0.
        const extended=new Uint8Array(first.length+3);
        extended.set(first.subarray(0,13));
        extended.set([0x80,0x80,0x01],13); // I extension and one-byte picture id.
        extended.set(first.subarray(13),16);
        const depacketizer=new Vp8RtpDepacketizer();
        expect(depacketizer.push(extended)).toBeNull();
        const gap=new Uint8Array(second);
        new DataView(gap.buffer).setUint16(2,12,false);
        expect(depacketizer.push(gap)).toBeNull();
    });
    test("rejects invalid sizes and empty encoded frames", () => {
        expect(()=>new Vp8RtpPacketizer({payloadType:96,ssrc:1,maxPacketSize:1390})).toThrow("1385");
        const sender=new Vp8RtpPacketizer({payloadType:96,ssrc:1});
        expect(()=>sender.packetize(new Uint8Array(),0)).toThrow("1..4194304");
    });
});

describe("VP8 video relay bridge", () => {
    test("reassembles VP8 continuation packets when signaling selected the H264 bridge", () => {
        const localSsrc = 0x12345678, remoteSsrc = 0x87654321;
        const sequence = 200;
        const frame = Uint8Array.from({length:700}, (_, index) => index & 0xff);
        frame.set([0,0,0,0x9d,0x01,0x2a]);
        const packetizer = new Vp8RtpPacketizer({payloadType:97,ssrc:localSsrc,initialSequenceNumber:sequence,maxPacketSize:256});
        const tx = new SrtpRtpContext({masterKeySalt,profile:1,direction:"send",ssrc:localSsrc,initialRoc:0,initialSequenceNumber:sequence});
        const rx = new SrtpRtpContext({masterKeySalt,profile:1,direction:"receive",ssrc:localSsrc,initialRoc:0,initialSequenceNumber:sequence});
        const frames: unknown[] = [];
        const bridge = new VideoRtpBridge({relay:{sendVideo:()=>{}},codec:"h264",payloadType:97,localSsrc:remoteSsrc,
            remoteSsrc:localSsrc,initialSequenceNumber:300,
            protect:new SrtpRtpContext({masterKeySalt,profile:1,direction:"send",ssrc:remoteSsrc,initialRoc:0,initialSequenceNumber:300}),
            unprotect:rx,onFrame:decoded=>frames.push(decoded)});
        bridge.setConfirmed(true);
        for (const packet of packetizer.packetize(frame,90000)) bridge.receiveRtp(tx.protect(packet));
        expect(frames).toEqual([{data:frame,timestamp:90000,keyFrame:true,codec:"vp8"}]);
        tx.destroy(); bridge.close();
    });
    test("holds TX until confirmation and round-trips fragmented SRTP frames with distinct state", () => {
        const localSsrc = 0x12345678, remoteSsrc = 0x87654321, initialSequenceNumber = 65530;
        const sent: Uint8Array[] = [], frames: Array<{data: Uint8Array; timestamp: number; keyFrame: boolean}> = [];
        const senderCrypto = new SrtpRtpContext({masterKeySalt, profile:1, direction:"send", ssrc:localSsrc,
            initialRoc:0, initialSequenceNumber});
        const sender = new VideoRtpBridge({relay:{sendVideo:packet=>sent.push(Uint8Array.from(packet))},payloadType:96,
            localSsrc,remoteSsrc,initialSequenceNumber,protect:senderCrypto,
            unprotect:new SrtpRtpContext({masterKeySalt,profile:1,direction:"receive",ssrc:remoteSsrc,initialRoc:0,initialSequenceNumber:77}),
            onFrame:frame=>frames.push(frame),maxPacketSize:256});
        const frame = Uint8Array.from({length:700},(_,index)=>index&0xff);
        frame.set([0x00,0x00,0x00,0x9d,0x01,0x2a]);
        expect(sender.sendFrame(frame,90000)).toBe(0);
        expect(sent).toHaveLength(0);
        sender.setConfirmed(true);
        const count = sender.sendFrame(frame,90000);
        expect(count).toBeGreaterThan(1);
        expect(sent).toHaveLength(count);

        const receiverCrypto = new SrtpRtpContext({masterKeySalt,profile:1,direction:"receive",ssrc:localSsrc,
            initialRoc:0,initialSequenceNumber});
        const receiver = new VideoRtpBridge({relay:{sendVideo:()=>{}},payloadType:96,localSsrc:remoteSsrc,
            remoteSsrc:localSsrc,initialSequenceNumber:77,
            protect:new SrtpRtpContext({masterKeySalt,profile:1,direction:"send",ssrc:remoteSsrc,initialRoc:0,initialSequenceNumber:77}),
            unprotect:receiverCrypto,onFrame:decoded=>frames.push(decoded),maxPacketSize:256});
        receiver.setConfirmed(true);
        for(const packet of sent) receiver.receiveRtp(packet);
        expect(frames).toEqual([{data:frame,timestamp:90000,keyFrame:true,codec:"vp8"}]);
        expect(receiver.rejectedPackets).toBe(0);
        sender.close(); receiver.close();
    });
});
