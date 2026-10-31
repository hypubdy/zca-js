/** Minimal compound RTCP SR/RR + SDES builder for the independent call path. */

export interface RtcpReportBlock {
    ssrc: number;
    fractionLost: number;
    cumulativeLost: number;
    extendedHighestSequence: number;
    jitter: number;
    lastSenderReport: number;
    delaySinceLastSenderReport: number;
}

export interface RtcpSenderInfo {
    ntpSeconds: number;
    ntpFraction: number;
    rtpTimestamp: number;
    packetCount: number;
    octetCount: number;
}

export interface BuildCompoundRtcpReportOptions {
    ssrc: number;
    cname: string;
    reportBlocks?: readonly RtcpReportBlock[];
    /** Include an SR when RTP has been sent during the current report interval. */
    senderInfo?: RtcpSenderInfo;
}

export interface ParsedRtcpPacketSummary {
    packetType: number;
    count: number;
    senderSsrc?: number;
    mediaSsrc?: number;
    senderInfo?: RtcpSenderInfo;
    reportBlocks?: RtcpReportBlock[];
}

function uint32(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
        throw new RangeError(`${field} must be an unsigned 32-bit integer`);
    return value;
}

function header(packet: Buffer, count: number, packetType: number) {
    packet[0] = 0x80 | count; // V=2, P=0
    packet[1] = packetType;
    packet.writeUInt16BE(packet.length / 4 - 1, 2);
}

function buildReport(options: BuildCompoundRtcpReportOptions): Buffer {
    const blocks = options.reportBlocks ?? [];
    if (blocks.length > 31) throw new RangeError("A single RTCP SR/RR supports at most 31 report blocks");
    const senderInfo = options.senderInfo;
    const packet = Buffer.alloc((senderInfo ? 28 : 8) + blocks.length * 24);
    header(packet, blocks.length, senderInfo ? 200 : 201);
    packet.writeUInt32BE(uint32(options.ssrc, "ssrc"), 4);
    let offset = 8;
    if (senderInfo) {
        packet.writeUInt32BE(uint32(senderInfo.ntpSeconds, "ntpSeconds"), offset); offset += 4;
        packet.writeUInt32BE(uint32(senderInfo.ntpFraction, "ntpFraction"), offset); offset += 4;
        packet.writeUInt32BE(uint32(senderInfo.rtpTimestamp, "rtpTimestamp"), offset); offset += 4;
        packet.writeUInt32BE(uint32(senderInfo.packetCount, "packetCount"), offset); offset += 4;
        packet.writeUInt32BE(uint32(senderInfo.octetCount, "octetCount"), offset); offset += 4;
    }
    for (const block of blocks) {
        packet.writeUInt32BE(uint32(block.ssrc, "report.ssrc"), offset);
        if (!Number.isInteger(block.fractionLost) || block.fractionLost < 0 || block.fractionLost > 255)
            throw new RangeError("report.fractionLost must be an unsigned 8-bit integer");
        if (!Number.isInteger(block.cumulativeLost) || block.cumulativeLost < -0x80_0000 || block.cumulativeLost > 0x7f_ffff)
            throw new RangeError("report.cumulativeLost must fit a signed 24-bit integer");
        packet[offset + 4] = block.fractionLost;
        packet.writeIntBE(block.cumulativeLost, offset + 5, 3);
        packet.writeUInt32BE(uint32(block.extendedHighestSequence, "report.extendedHighestSequence"), offset + 8);
        packet.writeUInt32BE(uint32(block.jitter, "report.jitter"), offset + 12);
        packet.writeUInt32BE(uint32(block.lastSenderReport, "report.lastSenderReport"), offset + 16);
        packet.writeUInt32BE(uint32(block.delaySinceLastSenderReport, "report.delaySinceLastSenderReport"), offset + 20);
        offset += 24;
    }
    return packet;
}

function buildSdes(ssrc: number, cname: string): Buffer {
    const value = Buffer.from(cname, "utf8");
    if (value.length === 0 || value.length > 255) throw new RangeError("CNAME must contain 1 to 255 UTF-8 bytes");
    const unpaddedLength = 4 + 4 + 2 + value.length + 1; // header, SSRC, CNAME item, END
    const packet = Buffer.alloc((unpaddedLength + 3) & ~3);
    header(packet, 1, 202);
    packet.writeUInt32BE(uint32(ssrc, "ssrc"), 4);
    packet[8] = 1; // SDES CNAME
    packet[9] = value.length;
    value.copy(packet, 10);
    packet[10 + value.length] = 0; // END item; Buffer.alloc supplies alignment padding.
    return packet;
}

/** Build a standards-shaped compound RTCP report; caller owns scheduling and transport. */
export function buildCompoundRtcpReport(options: BuildCompoundRtcpReportOptions): Buffer {
    if (!options || typeof options !== "object") throw new TypeError("RTCP report options are required");
    if (typeof options.cname !== "string") throw new TypeError("CNAME must be a string");
    const report = buildReport(options);
    return Buffer.concat([report, buildSdes(options.ssrc, options.cname)]);
}

/** Parse the report fields needed by the independent call state; unknown RTCP types remain opaque. */
export function parseCompoundRtcp(packet: Uint8Array): ParsedRtcpPacketSummary[] {
    if (!(packet instanceof Uint8Array) || packet.length < 8) throw new RangeError("RTCP compound packet is shorter than 8 bytes");
    const summaries: ParsedRtcpPacketSummary[] = [];
    let offset = 0;
    while (offset < packet.length) {
        if (packet.length - offset < 4) throw new RangeError("Truncated RTCP header");
        const first = packet[offset];
        if ((first >>> 6) !== 2) throw new TypeError("Invalid RTCP version");
        const packetType = packet[offset + 1];
        if (packetType < 192 || packetType > 223) throw new TypeError("Invalid RTCP packet type");
        const view = new DataView(packet.buffer, packet.byteOffset + offset, packet.byteLength - offset);
        const partLength = (view.getUint16(2, false) + 1) * 4;
        const count = first & 0x1f;
        if (partLength < 4 || partLength > packet.length - offset) throw new RangeError("Invalid RTCP packet length");
        if (summaries.length === 0 && partLength < 8) throw new RangeError("The first RTCP packet must include a sender SSRC");
        if ((first & 0x20) && offset + partLength !== packet.length) throw new RangeError("Only the final RTCP packet may use padding");
        if ((first & 0x20) && (!packet[offset + partLength - 1] || packet[offset + partLength - 1] > partLength - 4))
            throw new RangeError("Invalid RTCP padding");

        const summary: ParsedRtcpPacketSummary = { packetType, count };
        if ([200, 201, 202, 204, 205, 206, 207].includes(packetType)) {
            if (partLength < 8) throw new RangeError("RTCP packet is shorter than its sender SSRC");
            summary.senderSsrc = view.getUint32(4, false);
            if ((packetType === 205 || packetType === 206) && partLength >= 12) summary.mediaSsrc = view.getUint32(8, false);
        }
        if (packetType === 200 || packetType === 201) {
            const baseLength = packetType === 200 ? 28 : 8;
            if (partLength < baseLength + count * 24) throw new RangeError("Truncated RTCP report blocks");
            summary.reportBlocks = [];
            if (packetType === 200) {
                summary.senderInfo = {
                    ntpSeconds: view.getUint32(8, false),
                    ntpFraction: view.getUint32(12, false),
                    rtpTimestamp: view.getUint32(16, false),
                    packetCount: view.getUint32(20, false),
                    octetCount: view.getUint32(24, false),
                };
            }
            for (let i = 0; i < count; i++) {
                const blockOffset = baseLength + i * 24;
                const lostOffset = offset + blockOffset + 5;
                const lostBits = (packet[lostOffset] << 16) | (packet[lostOffset + 1] << 8) | packet[lostOffset + 2];
                summary.reportBlocks.push({
                    ssrc: view.getUint32(blockOffset, false),
                    fractionLost: view.getUint8(blockOffset + 4),
                    cumulativeLost: lostBits & 0x800000 ? lostBits - 0x1000000 : lostBits,
                    extendedHighestSequence: view.getUint32(blockOffset + 8, false),
                    jitter: view.getUint32(blockOffset + 12, false),
                    lastSenderReport: view.getUint32(blockOffset + 16, false),
                    delaySinceLastSenderReport: view.getUint32(blockOffset + 20, false),
                });
            }
        }
        summaries.push(summary);
        offset += partLength;
    }
    return summaries;
}

/** Build an RTCP PSFB Picture Loss Indication (RFC 4585), requesting a keyframe. */
export function buildRtcpPli(senderSsrc: number, mediaSsrc: number): Buffer {
    const packet = Buffer.alloc(12);
    uint32(senderSsrc, "senderSsrc"); uint32(mediaSsrc, "mediaSsrc");
    packet[0] = 0x81; packet[1] = 206; packet.writeUInt16BE(2, 2);
    packet.writeUInt32BE(senderSsrc, 4); packet.writeUInt32BE(mediaSsrc, 8);
    return packet;
}

/**
 * Build the compound RTCP shape emitted by the WebRTC stack embedded in
 * ZaloCall when RtcpMode is set to compound and RequestKeyFrame() selects PLI.
 * Older compound-RTCP receivers may discard a standalone feedback packet.
 */
export function buildCompoundRtcpPli(senderSsrc: number, mediaSsrc: number, cname: string,
    senderInfo?: RtcpSenderInfo): Buffer {
    const report = buildCompoundRtcpReport({ ssrc: senderSsrc, cname, senderInfo });
    return Buffer.concat([report, buildRtcpPli(senderSsrc, mediaSsrc)]);
}

/** Basic per-source RTP reception statistics used to populate one RTCP report block. */
export class RtpReceptionStats {
    private readonly clockRate: number;
    private baseSequence: number | null = null;
    private highestSequence: number | null = null;
    private readonly received = new Set<number>();
    private receivedTotal = 0;
    private previousExpected = 0;
    private previousReceived = 0;
    private previousTransit: number | null = null;
    private jitterValue = 0;
    private lastSenderReport = 0;
    private senderReportReceivedAt: number | null = null;

    constructor(clockRate: number) {
        if (!Number.isInteger(clockRate) || clockRate < 8000 || clockRate > 192000)
            throw new RangeError("RTP clock rate must be 8000..192000 Hz");
        this.clockRate = clockRate;
    }

    update(sequenceNumber: number, timestamp: number, arrivalTimeMs: number): boolean {
        if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0 || sequenceNumber > 0xffff ||
            !Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff ||
            !Number.isFinite(arrivalTimeMs) || arrivalTimeMs < 0)
            throw new RangeError("Invalid RTP reception sample");
        if (this.baseSequence === null) this.baseSequence = sequenceNumber;
        let extended = this.highestSequence === null ? sequenceNumber : (this.highestSequence & ~0xffff) | sequenceNumber;
        if (this.highestSequence !== null) {
            if (extended < this.highestSequence - 0x8000) extended += 0x1_0000;
            else if (extended > this.highestSequence + 0x8000) extended -= 0x1_0000;
        }
        if (extended < 0 || (this.highestSequence !== null && extended < this.highestSequence - 4096) || this.received.has(extended)) return false;
        this.received.add(extended);
        this.receivedTotal++;
        if (this.highestSequence === null || extended > this.highestSequence) this.highestSequence = extended;
        const oldest = (this.highestSequence ?? extended) - 4096;
        for (const value of this.received) if (value < oldest) this.received.delete(value);

        const transit = arrivalTimeMs * this.clockRate / 1000 - timestamp;
        if (this.previousTransit !== null) {
            const difference = Math.abs(transit - this.previousTransit);
            this.jitterValue += (difference - this.jitterValue) / 16;
        }
        this.previousTransit = transit;
        return true;
    }

    setLastSenderReport(ntpSeconds: number, ntpFraction: number, receivedAtMs: number) {
        uint32(ntpSeconds, "ntpSeconds"); uint32(ntpFraction, "ntpFraction");
        if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0) throw new RangeError("Invalid sender report receive time");
        this.lastSenderReport = ((ntpSeconds & 0xffff) << 16) | (ntpFraction >>> 16);
        this.senderReportReceivedAt = receivedAtMs;
    }

    reportBlock(ssrc: number, nowMs: number): RtcpReportBlock | undefined {
        uint32(ssrc, "report.ssrc");
        if (this.baseSequence === null || this.highestSequence === null || this.received.size === 0) return undefined;
        const expected = this.highestSequence - this.baseSequence + 1;
        const received = this.receivedTotal;
        const expectedInterval = expected - this.previousExpected;
        const receivedInterval = received - this.previousReceived;
        const lostInterval = Math.max(0, expectedInterval - receivedInterval);
        const fractionLost = expectedInterval > 0 ? Math.min(255, Math.floor(lostInterval * 256 / expectedInterval)) : 0;
        this.previousExpected = expected;
        this.previousReceived = received;
        const cumulativeLost = Math.max(-0x80_0000, Math.min(0x7f_ffff, expected - received));
        let delaySinceLastSenderReport = 0;
        if (this.senderReportReceivedAt !== null)
            delaySinceLastSenderReport = Math.min(0xffff_ffff, Math.max(0, Math.floor((nowMs - this.senderReportReceivedAt) * 65.536)));
        return {
            ssrc, fractionLost, cumulativeLost, extendedHighestSequence: this.highestSequence >>> 0,
            jitter: Math.max(0, Math.min(0xffff_ffff, Math.round(this.jitterValue))) >>> 0,
            lastSenderReport: this.lastSenderReport, delaySinceLastSenderReport,
        };
    }
}
