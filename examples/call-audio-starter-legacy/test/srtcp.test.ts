import { describe, expect, test } from "bun:test";
import { SrtcpContext } from "../dist/call-engine/srtcp.js";

const masterKeySalt = Buffer.from("e1f97a0d3e018be0d64fa32c06de41390ec675ad498afeebb6960b3aabe6", "hex");

function senderReport(ssrc = 0x11223344): Buffer {
    const packet = Buffer.alloc(28);
    packet[0] = 0x80; // V=2, no padding, zero report blocks
    packet[1] = 200; // Sender Report
    packet.writeUInt16BE(6, 2); // (6 + 1) * 4 = 28 bytes
    packet.writeUInt32BE(ssrc, 4);
    packet.writeUInt32BE(0x01020304, 8); // NTP timestamp high word
    packet.writeUInt32BE(0x05060708, 12); // NTP timestamp low word
    packet.writeUInt32BE(0x10203040, 16); // RTP timestamp
    packet.writeUInt32BE(1, 20); // sender packet count
    packet.writeUInt32BE(320, 24); // sender octet count
    return packet;
}

function pair(profile: 1 | 2 = 1) {
    return {
        send: new SrtcpContext({ masterKeySalt, profile, direction: "send" }),
        receive: new SrtcpContext({ masterKeySalt, profile, direction: "receive" }),
    };
}

describe("RFC 3711 SRTCP primitive; Zalo relay interoperability unverified", () => {
    test.each([1, 2] as const)("profile %i appends E/index and authenticates encrypted RTCP", profile => {
        const { send, receive } = pair(profile);
        const plain = senderReport();
        const protectedPacket = Buffer.from(send.protect(plain));

        expect(protectedPacket.length).toBe(plain.length + 14); // index/E word + default 80-bit RTCP tag
        expect(protectedPacket.subarray(0, 8)).toEqual(plain.subarray(0, 8));
        expect(protectedPacket.subarray(8, plain.length)).not.toEqual(plain.subarray(8));
        expect(protectedPacket.readUInt32BE(plain.length)).toBe(0x80000000); // E=1, index=0
        expect(Buffer.from(receive.unprotect(protectedPacket))).toEqual(plain);
        expect(() => receive.unprotect(protectedPacket)).toThrow("replay");
        send.destroy();
        receive.destroy();
    });

    test("profile2 keeps RTCP's default 80-bit tag instead of RTP's 32-bit tag", () => {
        const { send, receive } = pair(2);
        const plain = senderReport();
        const protectedPacket = Buffer.from(send.protect(plain));
        expect(protectedPacket.length - plain.length).toBe(14);
        expect(Buffer.from(receive.unprotect(protectedPacket))).toEqual(plain);
        send.destroy();
        receive.destroy();
    });

    test("E=0 leaves the RTCP body clear but remains authenticated and replay protected", () => {
        const { send, receive } = pair();
        const plain = senderReport();
        const protectedPacket = Buffer.from(send.protect(plain, false));
        expect(protectedPacket.subarray(0, plain.length)).toEqual(plain);
        expect(protectedPacket.readUInt32BE(plain.length)).toBe(0);
        expect(Buffer.from(receive.unprotect(protectedPacket))).toEqual(plain);
        send.destroy();
        receive.destroy();
    });

    test("bad authentication does not poison the receiver replay state", () => {
        const { send, receive } = pair();
        const protectedPacket = Buffer.from(send.protect(senderReport()));
        const tampered = Buffer.from(protectedPacket);
        tampered[9] ^= 1;
        expect(() => receive.unprotect(tampered)).toThrow("authentication");
        expect(Buffer.from(receive.unprotect(protectedPacket))).toEqual(senderReport());
        send.destroy();
        receive.destroy();
    });

    test("keeps RTCP validation, direction, and fail-closed lifecycle checks", () => {
        const { send, receive } = pair();
        expect(() => send.protect(Buffer.from([0x80, 201, 0, 1]))).toThrow("shorter than 8 bytes");
        expect(() => receive.protect(senderReport())).toThrow("cannot send");
        expect(() => send.unprotect(senderReport())).toThrow("cannot receive");
        send.destroy();
        expect(() => send.protect(senderReport())).toThrow("cannot send");
        receive.destroy();
    });
});
