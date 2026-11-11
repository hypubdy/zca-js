import { describe, expect, test } from "bun:test";
import { createCipheriv, createHmac } from "node:crypto";
import { applySrtpAesCm, deriveSrtpRtpKeys, SrtpRtpContext } from "../../../src/call/srtpRtp.js";
// Published inputs/outputs: https://www.rfc-editor.org/rfc/rfc3711#appendix-B.2
// and appendix B.3. These are public vectors, never account/session secrets.
const master = Buffer.from("e1f97a0d3e018be0d64fa32c06de41390ec675ad498afeebb6960b3aabe6", "hex");
const ssrc = 0x11223344;
function packet(sequence, extended = false) {
    const headerLength = extended ? 28 : 12;
    const out = Buffer.alloc(headerLength + 20);
    out[0] = extended ? 0xb1 : 0x80; // extension, one CSRC, padding
    out[1] = 112;
    out.writeUInt16BE(sequence, 2);
    out.writeUInt32BE(0x10203040, 4);
    out.writeUInt32BE(ssrc, 8);
    if (extended) {
        out.writeUInt32BE(0x55667788, 12);
        out.writeUInt16BE(0xbede, 16);
        out.writeUInt16BE(2, 18);
        out.fill(0x55, 20, 28);
    }
    out.fill(0xab, headerLength);
    if (extended)
        out[out.length - 1] = 4;
    return out;
}
function contexts(profile = 1, sequence = 65534, roc = 0, replayWindow = 64) {
    const options = { masterKeySalt: master, profile, ssrc, initialRoc: roc, initialSequenceNumber: sequence, replayWindow };
    return { sender: new SrtpRtpContext(Object.assign(Object.assign({}, options), { direction: "send" })), receiver: new SrtpRtpContext(Object.assign(Object.assign({}, options), { direction: "receive" })) };
}
describe("independent RFC 3711 RTP primitive; Zalo interoperability unverified", () => {
    test("published appendix B.3 encryption, salt and authentication KDF vectors", () => {
        const keys = deriveSrtpRtpKeys(master);
        expect(Buffer.from(keys.encryptionKey).toString("hex")).toBe("c61e7a93744f39ee10734afe3ff7a087");
        expect(Buffer.from(keys.salt).toString("hex")).toBe("30cbbc08863d8c85d49db34a9ae1");
        // RFC prints 94-byte PRF output; HMAC-SHA1 uses its first20 bytes.
        expect(Buffer.from(keys.authenticationKey).toString("hex")).toBe("cebe321f6ff7716b6fd4ab49af256a156d38baa4");
    });
    test("published appendix B.2 first and final AES-CM keystream blocks", () => {
        const stream = Buffer.from(applySrtpAesCm(Buffer.alloc(1044512), Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex"), Buffer.from("f0f1f2f3f4f5f6f7f8f9fafbfcfd", "hex"), { roc: 0, sequenceNumber: 0, ssrc: 0 }));
        expect(stream.subarray(0, 48).toString("hex")).toBe("e03ead0935c95e80e166b16dd92b4eb4d23513162b02d0f72a43a2fe4a5f97ab41e95b3bb0a2e8dd477901e4fca894c0");
        expect(stream.subarray(0xfeff * 16, 0xff02 * 16).toString("hex")).toBe("ec8cdf7398607cb0f2d21675ea9ea1e4362b7c3c6773516318a077d7fc5073ae6a2cc3787889374fbeb4c81b17ba6c44");
    });
    test("nonzero SSRC/ROC/sequence occupy their specified IV bits", () => {
        const key = Buffer.alloc(16);
        const salt = Buffer.from("30cbbc08863d8c85d49db34a9ae1", "hex");
        // Hand XOR of RFC4.1.1 formula, not the implementation's IV builder:
        // salt<<16 XOR 11223344<<64 XOR 12345678cdef<<16.
        const expectedIv = Buffer.from("30cbbc08971fbfc1c6a9e532570e0000", "hex");
        const aes = createCipheriv("aes-128-ecb", key, null);
        aes.setAutoPadding(false);
        const expected = Buffer.concat([aes.update(expectedIv), aes.final()]);
        expect(Buffer.from(applySrtpAesCm(Buffer.alloc(16), key, salt, { ssrc, roc: 0x12345678, sequenceNumber: 0xcdef }))).toEqual(expected);
    });
    for (const profile of [1, 2]) {
        test(`profile ${profile}: RTP header/CSRC/extensions clear, payload+padding encrypted, HMAC includes ROC`, () => {
            const { sender, receiver } = contexts(profile, 42, 7);
            const plain = packet(42, true);
            const input = Buffer.from(plain);
            const wire = Buffer.from(sender.protect(plain));
            expect(plain).toEqual(input);
            expect(wire.subarray(0, 28)).toEqual(plain.subarray(0, 28));
            expect(wire.subarray(28, plain.length)).not.toEqual(plain.subarray(28));
            const roc = Buffer.from([0, 0, 0, 7]);
            const expectedTag = createHmac("sha1", deriveSrtpRtpKeys(master).authenticationKey)
                .update(wire.subarray(0, plain.length)).update(roc).digest().subarray(0, profile === 1 ? 10 : 4);
            expect(wire.subarray(plain.length)).toEqual(expectedTag);
            expect(Buffer.from(receiver.unprotect(wire))).toEqual(plain);
            sender.destroy();
            receiver.destroy();
        });
        test(`profile ${profile}: rollover, previous ROC reorder, duplicate and stale replay rejection`, () => {
            const { sender, receiver } = contexts(profile);
            const packets = [65534, 65535, 0, 1].map((seq) => Buffer.from(sender.protect(packet(seq))));
            // Receive rollover first after65534; then late packet from previous ROC.
            for (const index of [0, 2, 1, 3])
                expect(Buffer.from(receiver.unprotect(packets[index]))).toEqual(packet([65534, 65535, 0, 1][index]));
            expect(() => receiver.unprotect(packets[1])).toThrow("replay");
            const delayed = sender.protect(packet(2));
            const ahead = sender.protect(packet(66));
            receiver.unprotect(ahead);
            expect(() => receiver.unprotect(delayed)).toThrow("replay");
            expect(() => sender.protect(packet(66))).toThrow("reuse");
            sender.destroy();
            receiver.destroy();
        });
        test(`profile ${profile}: header/payload/tag tampering cannot poison receive state`, () => {
            const { sender, receiver } = contexts(profile, 1);
            const wire = Buffer.from(sender.protect(packet(1)));
            for (const offset of [1, 2, 4, 12, wire.length - 1]) {
                const corrupt = Buffer.from(wire);
                corrupt[offset] ^= 1;
                expect(() => receiver.unprotect(corrupt)).toThrow("authentication");
            }
            expect(Buffer.from(receiver.unprotect(wire))).toEqual(packet(1));
            sender.destroy();
            receiver.destroy();
        });
    }
    test("explicit ROC/SSRC, boundaries, direction, mode and lifecycle fail closed", () => {
        const options = { masterKeySalt: master, profile: 1, direction: "receive", ssrc, initialRoc: 0, initialSequenceNumber: 0 };
        expect(() => new SrtpRtpContext(Object.assign(Object.assign({}, options), { profile: 3 }))).toThrow("profiles");
        expect(() => new SrtpRtpContext(Object.assign(Object.assign({}, options), { noSeq: 1 }))).toThrow("noSeq");
        expect(() => new SrtpRtpContext(Object.assign(Object.assign({}, options), { initialRoc: -1 }))).toThrow("ROC");
        expect(() => new SrtpRtpContext(Object.assign(Object.assign({}, options), { initialSequenceNumber: undefined }))).toThrow("sequence");
        expect(() => deriveSrtpRtpKeys(master.subarray(0, 29))).toThrow();
        const { sender, receiver } = contexts(1, 0, 1);
        const wire = sender.protect(packet(0));
        const wrongRoc = new SrtpRtpContext(options);
        expect(() => wrongRoc.unprotect(wire)).toThrow("authentication");
        const wrongSsrc = Buffer.from(wire);
        wrongSsrc[8] ^= 1;
        expect(() => receiver.unprotect(wrongSsrc)).toThrow("SSRC");
        expect(() => sender.unprotect(wire)).toThrow("cannot receive");
        expect(() => receiver.protect(packet(0))).toThrow("cannot send");
        expect(() => receiver.unprotect(wire.subarray(0, 12))).toThrow("Truncated");
        const truncatedExtension = packet(1, true).subarray(0, 18);
        expect(() => sender.protect(truncatedExtension)).toThrow("extension");
        const padded = packet(1, true);
        padded[padded.length - 1] = 21;
        expect(() => sender.protect(padded)).toThrow("padding");
        sender.destroy();
        receiver.destroy();
        wrongRoc.destroy();
        expect(() => sender.protect(packet(1))).toThrow("cannot send");
        expect(() => receiver.unprotect(wire)).toThrow("cannot receive");
        const exhausted = contexts(1, 65535, 0xffffffff);
        exhausted.sender.protect(packet(65535));
        expect(() => exhausted.sender.protect(packet(0))).toThrow("rekey");
        exhausted.sender.destroy();
        exhausted.receiver.destroy();
    });
});
