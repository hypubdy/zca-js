import { describe, expect, test } from "bun:test";
import { buildCompoundRtcpReport, parseCompoundRtcp, RtpReceptionStats } from "../src/call/rtcp.js";

describe("compound RTCP report builder", () => {
    test("builds RR plus CNAME SDES when no RTP was sent", () => {
        const packet = buildCompoundRtcpReport({ ssrc: 0x11223344, cname: "browser@example.test" });
        expect(packet.length % 4).toBe(0);
        expect(packet[0]).toBe(0x80);
        expect(packet[1]).toBe(201);
        expect(packet.readUInt16BE(2)).toBe(1);
        expect(packet.readUInt32BE(4)).toBe(0x11223344);
        const sdesOffset = 8;
        expect(packet[sdesOffset]).toBe(0x81);
        expect(packet[sdesOffset + 1]).toBe(202);
        expect(packet.readUInt32BE(sdesOffset + 4)).toBe(0x11223344);
        expect(packet.subarray(sdesOffset + 8, sdesOffset + 31)).toEqual(Buffer.from([1, 20, ...Buffer.from("browser@example.test"), 0]));
        expect(packet.readUInt16BE(sdesOffset + 2)).toBe(packet.subarray(sdesOffset).length / 4 - 1);
    });

    test("builds SR sender info and signed 24-bit report statistics", () => {
        const packet = buildCompoundRtcpReport({
            ssrc: 5,
            cname: "c",
            senderInfo: { ntpSeconds: 1, ntpFraction: 2, rtpTimestamp: 3, packetCount: 4, octetCount: 5 },
            reportBlocks: [{ ssrc: 6, fractionLost: 7, cumulativeLost: -2, extendedHighestSequence: 8, jitter: 9, lastSenderReport: 10, delaySinceLastSenderReport: 11 }],
        });
        expect(packet[0]).toBe(0x81);
        expect(packet[1]).toBe(200);
        expect(packet.readUInt32BE(4)).toBe(5);
        expect(packet.readUInt32BE(8)).toBe(1);
        expect(packet.readUInt32BE(24)).toBe(5);
        expect(packet.readUInt32BE(28)).toBe(6);
        expect(packet[32]).toBe(7);
        expect(packet.readIntBE(33, 3)).toBe(-2);
        expect(packet.readUInt32BE(48)).toBe(11);
        expect(packet[52 + 1]).toBe(202);
        const parsed = parseCompoundRtcp(packet);
        expect(parsed.map(item => item.packetType)).toEqual([200, 202]);
        expect(parsed[0].reportBlocks?.[0].cumulativeLost).toBe(-2);
        expect(parsed[0].reportBlocks?.[0].delaySinceLastSenderReport).toBe(11);
    });

    test("rejects invalid CNAME, out-of-range stats, and too many report blocks", () => {
        expect(() => buildCompoundRtcpReport({ ssrc: 1, cname: "" })).toThrow("CNAME");
        expect(() => buildCompoundRtcpReport({ ssrc: 1, cname: "x", senderInfo: { ntpSeconds: -1, ntpFraction: 0, rtpTimestamp: 0, packetCount: 0, octetCount: 0 } })).toThrow("ntpSeconds");
        expect(() => buildCompoundRtcpReport({ ssrc: 1, cname: "x", reportBlocks: Array.from({ length: 32 }, () => ({ ssrc: 1, fractionLost: 0, cumulativeLost: 0, extendedHighestSequence: 0, jitter: 0, lastSenderReport: 0, delaySinceLastSenderReport: 0 })) })).toThrow("31 report blocks");
    });

    test("rejects truncated and malformed compound RTCP packets", () => {
        expect(() => parseCompoundRtcp(new Uint8Array([0x80, 201, 0, 0, 0, 0, 0, 1]))).toThrow("first RTCP packet");
        expect(() => parseCompoundRtcp(new Uint8Array([0x80, 201, 0, 2, 0, 0, 0, 1]))).toThrow("packet length");
        const packet = buildCompoundRtcpReport({ ssrc: 1, cname: "x" });
        packet[0] = 0;
        expect(() => parseCompoundRtcp(packet)).toThrow("version");
    });

    test("tracks sequence wrap, loss, jitter, and sender-report delay for RR blocks", () => {
        const stats = new RtpReceptionStats(16000);
        expect(stats.update(100, 0, 1000)).toBe(true);
        expect(stats.update(100, 0, 1001)).toBe(false);
        expect(stats.update(102, 640, 1040)).toBe(true);
        stats.setLastSenderReport(0x12345678, 0x9abcdef0, 1040);
        const block = stats.reportBlock(0x11223344, 1140)!;
        expect(block.extendedHighestSequence).toBe(102);
        expect(block.cumulativeLost).toBe(1);
        expect(block.fractionLost).toBe(85);
        expect(block.jitter).toBe(0);
        expect(block.lastSenderReport).toBe(0x56789abc);
        expect(block.delaySinceLastSenderReport).toBe(6553);

        const wrapped = new RtpReceptionStats(48000);
        wrapped.update(65535, 0, 1000);
        wrapped.update(0, 960, 1020);
        expect(wrapped.reportBlock(2, 1020)?.extendedHighestSequence).toBe(65536);
        expect(wrapped.reportBlock(2, 1020)?.cumulativeLost).toBe(0);
    });
});
