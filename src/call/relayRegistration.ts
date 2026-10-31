import dgram from "node:dgram";
import { isIP } from "node:net";
import { decodeZrtpPacket, encodeZrtpPacket, type ZrtpControlPacket } from "./zrtpPacket.js";
import { decodeZrtpRelayMedia, encodeZrtpRelayMedia } from "./relayMediaPacket.js";

export type ZrtpRelayInit = {
    isCaller: boolean;
    userId: number;
    partnerId: number;
    callId: number;
    sessionId: string;
    /** Native call-state-dependent value; caller must choose the observed variant. */
    subcommand: 1 | 2;
};
export type ZrtpRelayResponse = {
    status: number;
    field38?: number;
    token?: number;
    /** Opaque server response bytes; may contain secrets, never log. */
    serverData?: Uint8Array;
};
function u32(value: number, name: string) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be uint32`);
    return value;
}

/** Recovered normal init11/12, not the group/loopback variant. */
export function buildZrtpRelayInit(input: ZrtpRelayInit): Uint8Array {
    if (typeof input.isCaller !== "boolean" || (input.subcommand !== 1 && input.subcommand !== 2))
        throw new TypeError("Invalid relay role or subcommand");
    if (typeof input.sessionId !== "string") throw new TypeError("sessionId must be a string");
    const session = Buffer.from(input.sessionId, "utf8");
    if (session.length > 65504) throw new RangeError("Session exceeds bounded init datagram");
    const payload = Buffer.alloc(10 + session.length);
    payload.writeUInt32LE(u32(input.callId, "callId"), 0);
    payload.writeUInt32LE(u32(input.partnerId, "partnerId"), 4);
    payload.writeUInt16LE(session.length, 8);
    payload.set(session, 10);
    return encodeZrtpPacket({kind:"control",type:1,version:126,field0c:0,field10:0,
        field14:u32(input.userId,"userId"),token:0,command:input.isCaller ? 11 : 12,subcommand:input.subcommand,payload});
}

/** Recovered type2 response body; reject truncation rather than native silent defaults. */
export function parseZrtpRelayResponse(packet: ZrtpControlPacket): ZrtpRelayResponse {
    if (packet.type !== 2 || (packet.command !== 11 && packet.command !== 12)) throw new TypeError("Not a relay init response");
    const body = packet.payload;
    if (body.length < 4) throw new RangeError("Truncated relay status");
    const view = new DataView(body.buffer,body.byteOffset,body.byteLength);
    const status = view.getUint32(0,true);
    if (status !== 0) return {status};
    if (body.length < 14) throw new RangeError("Truncated successful relay response");
    const size = view.getUint16(12,true);
    if (body.length < 14 + size) throw new RangeError("Truncated relay server data");
    return {status,field38:view.getUint32(4,true),token:view.getUint32(8,true),serverData:Uint8Array.from(body.subarray(14,14+size))};
}

/**
 * Explicit single-relay experiment, no ZaloCall, no discovery or network at import.
 * This proves only relay registration when successful, never an answered call.
 * Caller supplies a literal IP from its authorized offer. UDP socket is closed
 * after this probe; a continuous media engine must retain its own bound socket.
 */
export async function probeZrtpRelay(input: ZrtpRelayInit, relay: {address:string;port:number}, timeoutMs = 1500): Promise<ZrtpRelayResponse> {
    const family = isIP(relay.address);
    if (!family || !Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535) throw new TypeError("Relay must be a literal IP and valid port");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RangeError("Invalid relay timeout");
    const request = buildZrtpRelayInit(input);
    const command = input.isCaller ? 11 : 12;
    const socket = dgram.createSocket(family === 4 ? "udp4" : "udp6");
    return new Promise((resolve,reject) => {
        let settled = false;
        const timer = setTimeout(() => done(new Error("Relay init timed out; call is not established")),timeoutMs);
        function done(error?: Error, result?: ZrtpRelayResponse) {
            if (settled) return; settled = true; clearTimeout(timer);
            try { socket.close(); } catch { /* socket may not have bound yet */ }
            if (error) reject(error); else resolve(result!);
        }
        socket.on("error",done);
        // Connected UDP filters foreign sender addresses and ports in the kernel.
        socket.on("message",bytes => {
            try {
                const packet = decodeZrtpPacket(bytes);
                if (packet.kind !== "control" || packet.type !== 2 || packet.command !== command) return;
                done(undefined,parseZrtpRelayResponse(packet));
            } catch { /* Ignore unrelated/malformed traffic until bounded timeout. */ }
        });
        socket.connect(relay.port,relay.address,() => socket.send(request,error => { if (error) done(error); }));
    });
}

export type ZrtpRelaySessionOptions = {
    /** Retry cadence is observed natively; attempt count is an explicit local bound. */
    retryEveryMs?: number;
    maxAttempts?: number;
    responseTimeoutMs?: number;
    keepaliveEveryMs?: number;
    onMedia?: (packet: import("./relayMediaPacket.js").ZrtpRelayMedia) => void;
    onError?: (error: Error) => void;
};

/**
 * Persistent relay transport for an already observed call. Unlike
 * probeZrtpRelay, this retains the connected UDP socket/token and keeps the
 * session alive. It only establishes relay registration: it does not answer
 * the call, negotiate media security, or make mediaReady true.
 */
export class ZrtpRelaySession {
    readonly relay: { address: string; port: number };
    readonly localUserId: number;
    readonly callId: number;
    private readonly token: number;
    private readonly socket: ReturnType<typeof dgram.createSocket>;
    private readonly init: ZrtpRelayInit;
    private readonly options: Required<Pick<ZrtpRelaySessionOptions, "retryEveryMs" | "maxAttempts" | "responseTimeoutMs" | "keepaliveEveryMs">> & ZrtpRelaySessionOptions;
    private keepalive?: ReturnType<typeof setInterval>;
    private closed = false;

    private constructor(socket: ReturnType<typeof dgram.createSocket>, input: ZrtpRelayInit,
        relay: { address: string; port: number }, response: ZrtpRelayResponse, options: ZrtpRelaySessionOptions) {
        this.socket = socket;
        this.init = input;
        this.relay = relay;
        this.token = response.token!;
        this.localUserId = input.userId >>> 0;
        this.callId = input.callId >>> 0;
        this.options = { retryEveryMs: 1000, maxAttempts: 3, responseTimeoutMs: 1000, keepaliveEveryMs: 6000, ...options };
        this.socket.on("message", bytes => this.receive(bytes));
        this.keepalive = setInterval(() => this.ping(), this.options.keepaliveEveryMs);
        this.keepalive.unref?.();
    }

    static async open(input: ZrtpRelayInit, relay: { address: string; port: number }, options: ZrtpRelaySessionOptions = {}): Promise<ZrtpRelaySession> {
        const family = isIP(relay.address);
        if (!family || !Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535)
            throw new TypeError("Relay must be a literal IP and valid port");
        const retryEveryMs = options.retryEveryMs ?? 1000;
        const maxAttempts = options.maxAttempts ?? 3;
        const responseTimeoutMs = options.responseTimeoutMs ?? 1000;
        const keepaliveEveryMs = options.keepaliveEveryMs ?? 6000;
        if (![retryEveryMs, responseTimeoutMs, keepaliveEveryMs].every(value => Number.isInteger(value) && value >= 100 && value <= 60000))
            throw new RangeError("Relay timer values must be 100..60000 ms");
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
            throw new RangeError("Relay registration attempts must be 1..10");
        const socket = dgram.createSocket(family === 4 ? "udp4" : "udp6");
        const command = input.isCaller ? 11 : 12;
        const request = buildZrtpRelayInit(input);
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => { socket.off("connect", onConnect); reject(error); };
                const onConnect = () => { socket.off("error", onError); resolve(); };
                socket.once("error", onError);
                socket.once("connect", onConnect);
                socket.connect(relay.port, relay.address);
            });
            // Keep a listener attached even between bounded registration retries.
            socket.on("error", error => options.onError?.(error));
            let response: ZrtpRelayResponse | undefined;
            for (let attempt = 0; attempt < maxAttempts && !response; attempt++) {
                const attemptStartedAt = Date.now();
                const wait = new Promise<ZrtpRelayResponse>((resolve, reject) => {
                    const onError = (error: Error) => {
                        clearTimeout(timer);
                        socket.off("message", onMessage);
                        reject(error);
                    };
                    const timer = setTimeout(() => {
                        socket.off("message", onMessage);
                        socket.off("error", onError);
                        reject(new Error("Relay registration timed out"));
                    }, responseTimeoutMs);
                    const onMessage = (bytes: Buffer) => {
                        try {
                            const packet = decodeZrtpPacket(bytes);
                            if (packet.kind !== "control" || packet.type !== 2 || packet.command !== command) return;
                            clearTimeout(timer);
                            socket.off("message", onMessage);
                            socket.off("error", onError);
                            resolve(parseZrtpRelayResponse(packet));
                        } catch { /* Ignore unrelated/malformed datagrams until timeout. */ }
                    };
                    socket.on("message", onMessage);
                    socket.once("error", onError);
                });
                socket.send(request);
                try { response = await wait; }
                catch (error) {
                    if (attempt + 1 >= maxAttempts) throw error;
                    const pause = Math.max(0, retryEveryMs - (Date.now() - attemptStartedAt));
                    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
                }
            }
            if (!response || response.status !== 0 || response.token === undefined)
                throw new Error(`Relay rejected registration${response ? ` (status ${response.status})` : ""}`);
            return new ZrtpRelaySession(socket, input, relay, response, options);
        } catch (error) {
            try { socket.close(); } catch { /* close if bound */ }
            throw error;
        }
    }

    get registered(): boolean { return !this.closed; }

    private receive(bytes: Buffer) {
        if (this.closed || bytes.length === 0) return;
        try {
            const media = decodeZrtpRelayMedia(bytes);
            if (media.token !== undefined && media.token !== this.token) return;
            this.options.onMedia?.(media);
        } catch {
            // Relay control responses and malformed/unknown packets do not enter the media callback.
        }
    }

    private sendControl(version: number, command: number, subcommand: number, payload: Uint8Array) {
        if (!this.registered) throw new Error("Relay session is closed");
        const bytes = encodeZrtpPacket({ kind: "control", type: 1, version, field0c: 0, field10: 0,
            field14: this.localUserId, token: this.token, command, subcommand, payload });
        this.socket.send(bytes);
    }

    private ping() {
        if (!this.registered) return;
        const session = Buffer.from(this.init.sessionId, "utf8");
        const body = Buffer.alloc(2 + session.length);
        body.writeUInt16LE(session.length, 0); body.set(session, 2);
        try { this.sendControl(1, 2, 1, body); }
        catch (error) { this.options.onError?.(error as Error); }
    }

    /** Caller must pass an already protected RTP packet from the negotiated SRTP context. */
    sendAudio(rtp: Uint8Array) { this.sendRelayMedia("audio", rtp); }
    /** Caller must apply negotiated SRTCP first when SRTCP is enabled. */
    sendAudioRtcp(rtcp: Uint8Array) { this.sendRelayMedia("audioRtcp", rtcp); }
    /** Video uses its own negotiated SRTP context before this relay wrapper. */
    sendVideo(rtp: Uint8Array) { this.sendRelayMedia("video", rtp); }
    /** Caller must apply video SRTCP first when negotiated. */
    sendVideoRtcp(rtcp: Uint8Array) { this.sendRelayMedia("videoRtcp", rtcp); }

    /** Forward the native local-camera state (RequestForward subcommand 7=on, 8=off). */
    sendLocalCameraState(on: boolean, reason = 0) {
        if (!this.registered) throw new Error("Relay session is not registered");
        if (typeof on !== "boolean") throw new TypeError("Camera state must be boolean");
        if (!Number.isInteger(reason) || reason < -0x80000000 || reason > 0x7fffffff)
            throw new RangeError("Camera-state reason must be int32");
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setInt32(0, reason, true);
        // Native CallController::vidSetLocalOffCamera(state, reason) maps state=1
        // (camera active) to subcommand 7 and state=0 (off camera) to subcommand 8.
        // Request-forward addresses the peer in the token-position field.
        const bytes = encodeZrtpPacket({ kind: "control", type: 1, version: 1,
            field0c: 0, field10: 0, field14: this.localUserId,
            token: this.init.partnerId >>> 0, command: 0x20, subcommand: on ? 0x07 : 0x08, payload });
        this.socket.send(bytes);
    }

    /** Forward the native camera on/off state (command 0x20/subcommand 0x11). */
    sendVideoSuspend(suspended: boolean, reason = 0) {
        if (!this.registered) throw new Error("Relay session is not registered");
        if (!Number.isInteger(reason) || reason < -0x8000 || reason > 0x7fff)
            throw new RangeError("Video suspend reason must be int16");
        const payload = new Uint8Array(4);
        const view = new DataView(payload.buffer);
        view.setUint16(0, suspended ? 1 : 0, true);
        view.setInt16(2, reason, true);
        // Request-forward addresses the peer in the token-position field; it
        // does not use the media relay token there.
        const bytes = encodeZrtpPacket({ kind: "control", type: 1, version: 1,
            field0c: 0, field10: 0, field14: this.localUserId,
            token: this.init.partnerId >>> 0, command: 0x20, subcommand: 0x11, payload });
        this.socket.send(bytes);
    }

    private sendRelayMedia(kind: "audio" | "audioRtcp" | "video" | "videoRtcp", payload: Uint8Array) {
        if (!this.registered) throw new Error("Relay session is not registered");
        const bytes = encodeZrtpRelayMedia({ kind, token: this.token, payload });
        this.socket.send(bytes);
    }

    close(sendEnd = true) {
        if (this.closed) return;
        this.closed = true;
        if (this.keepalive) clearInterval(this.keepalive);
        if (sendEnd) {
            const body = Buffer.alloc(4); body.writeUInt32LE(this.callId, 0);
            try {
                const bytes = encodeZrtpPacket({ kind: "control", type: 1, version: 126, field0c: 0, field10: 0,
                    field14: this.localUserId, token: this.token, command: 3, subcommand: 0, payload: body });
                this.socket.send(bytes, () => this.closeSocket());
                return;
            } catch { /* Teardown must still close locally. */ }
        }
        this.closeSocket();
    }

    private closeSocket() {
        try { this.socket.close(); } catch { /* socket may already be closed */ }
    }
}
