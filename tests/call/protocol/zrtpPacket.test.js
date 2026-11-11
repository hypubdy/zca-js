import { describe, expect, test } from "bun:test";
import { decodeZrtpPacket, encodeZrtpPacket } from "../../../src/call/zrtpPacket.js";
// Hand-transcribed static layout fixtures, NOT captured successful relay traffic.
describe("recovered ZRTP envelopes (offline)", () => {
    test("modern audio/RTCP wraps opaque bytes with little-endian call field", () => {
        const wire = Buffer.from("7f000144332211060080700001", "hex");
        const decoded = decodeZrtpPacket(wire);
        expect(decoded).toEqual({ kind: "media", version: 0, role: 1, field38: 0x11223344, command: 6, payload: Uint8Array.from([0x80, 0x70, 0, 1]) });
        expect(Buffer.from(encodeZrtpPacket(decoded))).toEqual(wire);
        for (const command of [6, 7, 8, 9, 10]) {
            const copy = Buffer.from(wire);
            copy.writeUInt16LE(command, 7);
            expect(decodeZrtpPacket(copy).command).toBe(command);
        }
    });
    test("control and P2P headers have distinct offsets and preserve unknown body", () => {
        const control = Buffer.from("017e04030201080706050c0b0a09100f0e0d0b0004aabb", "hex");
        expect(decodeZrtpPacket(control)).toEqual({ kind: "control", type: 1, version: 126, field0c: 0x01020304, field10: 0x05060708,
            field14: 0x090a0b0c, token: 0x0d0e0f10, command: 11, subcommand: 4, payload: Uint8Array.from([0xaa, 0xbb]) });
        const p2p = Buffer.from("7f00014433221101000208070605aabb", "hex");
        expect(decodeZrtpPacket(p2p)).toEqual({ kind: "p2p", version: 0, role: 1, field38: 0x11223344, command: 1, subcommand: 2, field10: 0x05060708, payload: Uint8Array.from([0xaa, 0xbb]) });
        expect(Buffer.from(encodeZrtpPacket(decodeZrtpPacket(control)))).toEqual(control);
        expect(Buffer.from(encodeZrtpPacket(decodeZrtpPacket(p2p)))).toEqual(p2p);
    });
    test("bounds every truncated header, rejects oversized media, and owns decoded bytes", () => {
        const wire = Buffer.from("7f000144332211060080700001", "hex");
        for (let length = 0; length < 9; length++)
            expect(() => decodeZrtpPacket(wire.subarray(0, length))).toThrow();
        const control = new Uint8Array(21);
        control[0] = 1;
        for (let length = 1; length < 21; length++)
            expect(() => decodeZrtpPacket(control.subarray(0, length))).toThrow();
        const large = new Uint8Array(1410);
        large.set(wire.subarray(0, 9));
        expect(() => decodeZrtpPacket(large)).toThrow("1400");
        expect(() => decodeZrtpPacket(Uint8Array.of(99))).toThrow("Unsupported");
        const packet = decodeZrtpPacket(wire);
        wire[9] = 0;
        expect(packet.payload[0]).toBe(0x80);
        expect(() => encodeZrtpPacket(Object.assign(Object.assign({}, packet), { version: 256 }))).toThrow();
    });
});
