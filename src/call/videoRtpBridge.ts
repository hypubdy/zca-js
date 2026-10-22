import { parseRtpPacket } from "./rtpAudio.js";
import { Vp8RtpDepacketizer, Vp8RtpPacketizer } from "./rtpVp8.js";
import { SrtpRtpContext } from "./srtpRtp.js";

export type VideoRelaySender = { sendVideo(packet: Uint8Array): void };
export type VideoRtpBridgeOptions = {
    relay: VideoRelaySender;
    payloadType: number;
    localSsrc: number;
    remoteSsrc: number;
    initialSequenceNumber: number;
    protect: SrtpRtpContext;
    unprotect: SrtpRtpContext;
    onFrame: (frame: { data: Uint8Array; timestamp: number; keyFrame: boolean }) => void;
    maxPacketSize?: number;
};

/**
 * VP8/RTP relay leg. Every negotiated media value and crypto context is injected;
 * this class does not guess the Zalo video payload type, SSRCs, or answer shape.
 */
export class VideoRtpBridge {
    readonly packetizer: Vp8RtpPacketizer;
    readonly depacketizer = new Vp8RtpDepacketizer();
    private confirmed = false;
    private closed = false;
    private readonly payloadType: number;
    private readonly remoteSsrc: number;
    private readonly relay: VideoRelaySender;
    private readonly protect: SrtpRtpContext;
    private readonly unprotect: SrtpRtpContext;
    private readonly onFrame: VideoRtpBridgeOptions["onFrame"];
    sentPackets = 0;
    receivedPackets = 0;
    rejectedPackets = 0;

    constructor(options: VideoRtpBridgeOptions) {
        if (!Number.isInteger(options.remoteSsrc) || options.remoteSsrc < 0 || options.remoteSsrc > 0xffffffff)
            throw new RangeError("Invalid remote video SSRC");
        if (!options.relay || typeof options.relay.sendVideo !== "function" || typeof options.onFrame !== "function")
            throw new TypeError("Video relay and decoded-frame callback are required");
        this.relay = options.relay;
        this.payloadType = options.payloadType;
        this.remoteSsrc = options.remoteSsrc;
        this.protect = options.protect;
        this.unprotect = options.unprotect;
        this.onFrame = options.onFrame;
        this.packetizer = new Vp8RtpPacketizer({ payloadType: options.payloadType, ssrc: options.localSsrc,
            initialSequenceNumber: options.initialSequenceNumber, maxPacketSize: options.maxPacketSize });
    }

    setConfirmed(confirmed: boolean) { this.confirmed = confirmed; }

    sendFrame(frame: Uint8Array, timestamp90k: number): number {
        if (this.closed) throw new Error("Video RTP bridge is closed");
        if (!this.confirmed) return 0;
        const packets = this.packetizer.packetize(frame, timestamp90k);
        for (const packet of packets) this.relay.sendVideo(this.protect.protect(packet));
        this.sentPackets += packets.length;
        return packets.length;
    }

    receiveRtp(encrypted: Uint8Array): boolean {
        if (this.closed) return false;
        if (!this.confirmed) return false;
        try {
            if (encrypted.length < 22 || encrypted[0] >>> 6 !== 2 || (encrypted[1] & 0x7f) !== this.payloadType)
                throw new Error("Invalid negotiated video RTP header");
            const ssrc = ((encrypted[8] * 0x1000000) + (encrypted[9] << 16) + (encrypted[10] << 8) + encrypted[11]) >>> 0;
            if (ssrc !== this.remoteSsrc) throw new Error("Unexpected video SSRC");
            // SRTP uses the explicit sequence seed to estimate ROC. The first
            // observed packet can be later if an initial datagram was lost.
            const clear = this.unprotect.unprotect(encrypted);
            const rtp = parseRtpPacket(clear);
            if (rtp.payloadType !== this.payloadType || rtp.ssrc !== this.remoteSsrc)
                throw new Error("Video RTP identity changed after SRTP authentication");
            const frame = this.depacketizer.push(clear);
            this.receivedPackets++;
            if (frame) this.onFrame({ ...frame, timestamp: rtp.timestamp });
            return Boolean(frame);
        } catch {
            this.rejectedPackets++;
            return false;
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.confirmed = false;
        this.depacketizer.reset();
        this.protect.destroy();
        this.unprotect.destroy();
    }
}
