import { describe, expect, test } from "bun:test";
import { encodeZrtpRelayMedia, decodeZrtpRelayMedia } from "../src/call/relayMediaPacket.js";

describe("directional relay audio envelopes (static fixtures)", () => {
    test("outgoing audio/RTCP/FEC use type3/5/7 and a little-endian token", () => {
        const payload=Uint8Array.from([0x80,0x70,0,1]);
        for (const [kind,type] of [["audio",3],["audioRtcp",5],["audioFec",7]] as const) {
            expect(Buffer.from(encodeZrtpRelayMedia({kind,token:0x11223344,payload})).toString("hex"))
                .toBe(type.toString(16).padStart(2,"0")+"4433221180700001");
        }
    });
    test("incoming audio omits token and differs from outgoing type and header", () => {
        const bytes=Buffer.from("0480700001","hex");
        const decoded=decodeZrtpRelayMedia(bytes);
        expect(decoded).toEqual({kind:"audio",payload:Uint8Array.from([0x80,0x70,0,1])});
        expect(decoded.token).toBeUndefined();
        bytes[1]=0;
        expect(decoded.payload[0]).toBe(0x80);
        expect(()=>decodeZrtpRelayMedia(Uint8Array.of(3))).toThrow("Unsupported");
    });
    test("RTCP token is parsed but not authenticated; FEC stays opaque", () => {
        expect(decodeZrtpRelayMedia(Buffer.from("054433221180c90001","hex"))).toEqual({kind:"audioRtcp",token:0x11223344,payload:Uint8Array.from([0x80,0xc9,0,1])});
        expect(decodeZrtpRelayMedia(Buffer.from("07aabb","hex"))).toEqual({kind:"audioFec",payload:Uint8Array.from([0xaa,0xbb])});
    });
    test("truncated/oversized envelopes fail; zero-body envelope is not valid inner audio", () => {
        for(let n=0;n<5;n++)expect(()=>decodeZrtpRelayMedia(Uint8Array.from([5,0,0,0,0]).subarray(0,n))).toThrow();
        expect(decodeZrtpRelayMedia(Uint8Array.of(4)).payload.length).toBe(0);
        const oversized=new Uint8Array(1402);oversized[0]=4;
        expect(()=>decodeZrtpRelayMedia(oversized)).toThrow("1400");
        expect(()=>encodeZrtpRelayMedia({kind:"audio",token:-1,payload:new Uint8Array()})).toThrow("token");
    });
});

describe("directional relay video envelopes (static native-derived fixtures)", () => {
    test("outgoing video RTP/RTCP use types13/15 with a little-endian token", () => {
        const payload=Uint8Array.from([0x80,0x60,0,1]);
        expect(Buffer.from(encodeZrtpRelayMedia({kind:"video",token:0x11223344,payload})).toString("hex"))
            .toBe("0d4433221180600001");
        expect(Buffer.from(encodeZrtpRelayMedia({kind:"videoRtcp",token:0x11223344,payload})).toString("hex"))
            .toBe("0f4433221180600001");
    });
    test("incoming video RTP type14 has a one-byte header; RTCP type15 retains token", () => {
        expect(decodeZrtpRelayMedia(Buffer.from("0e80600001","hex")))
            .toEqual({kind:"video",payload:Uint8Array.from([0x80,0x60,0,1])});
        expect(decodeZrtpRelayMedia(Buffer.from("0f4433221180c90001","hex")))
            .toEqual({kind:"videoRtcp",token:0x11223344,payload:Uint8Array.from([0x80,0xc9,0,1])});
    });
});
