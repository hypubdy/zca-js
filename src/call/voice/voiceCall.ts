import { EventEmitter } from "node:events";
import { parseZrtcOutgoingAnswer, parseZrtcOutgoingPreflight, type ZrtcIncomingOffer, type ZrtcOutgoingPreflight } from "../negotiation.js";
import type { ZrtpRelayMedia } from "../relayMediaPacket.js";
import { AudioSession, type AudioRelay } from "./audioSession.js";
import { CallError, redactMessage, toCallError } from "./errors.js";
import { asUint32, planIncoming, planOutgoing, securityForOutgoingAnswer, type MediaSecurity, type OutgoingPlan } from "./negotiate.js";
import type { CallDirection, CallLogger, CallState, CallStats, EndReason, OpenRelay, VoiceCallSignaling } from "./types.js";

/** @internal Shared runtime handed to each call by its controller. */
export type CallRuntime = {
    signaling: VoiceCallSignaling;
    logger: CallLogger;
    openRelay: OpenRelay;
    ringTimeoutMs: number;
    connectTimeoutMs: number;
    sendRinging: boolean;
    onEnded(call: VoiceCall): void;
};

/** Raw control as delivered by `listener.on("call")`. */
export type CallControl = { act: string; data: unknown };

const TERMINAL = new Set(["cancel", "endcall", "end_call", "end"]);
const ACK = new Set(["answerack", "answer_ack", "answer-ack"]);
const RINGING = new Set(["ringring", "ringing"]);
/** Native `UiAnswerCallEvent(false)` declines with answer status 3 (0x1000c8e6c). */
const DECLINE_STATUS = 3;
/** Native resends the accepted answer every 3 s while waiting for the ACK. */
const ANSWER_RESEND_MS = 3000;
const ANSWER_MAX_SENDS = 5;

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parseParams(data: Record<string, unknown>): Record<string, unknown> {
    if (typeof data.params === "string") { try { return record(JSON.parse(data.params)); } catch { return {}; } }
    return record(data.params);
}

/** Best-effort call ID extraction from a control payload. */
export function controlCallId(control: CallControl): string | undefined {
    const data = record(control.data);
    const params = parseParams(data);
    const value = data.callId ?? data.call_id ?? data.id ?? params.id ?? params.callId;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
    return undefined;
}

function controlStatus(control: CallControl): number | undefined {
    const data = record(control.data);
    const value = data.status ?? parseParams(data).status;
    const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
    return typeof number === "number" && Number.isInteger(number) ? number : undefined;
}

/** Interpret a mute_audio/unmute control. Field names are not yet confirmed live. */
function remoteMuteFrom(control: CallControl): boolean {
    if (/unmute/i.test(control.act)) return false;
    const data = record(control.data);
    const params = parseParams(data);
    for (const source of [params, data]) {
        for (const key of ["isMute", "mute", "muted", "isMuted"]) {
            const value = source[key];
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value !== 0;
        }
        if (typeof source.isOnMic === "number") return source.isOnMic === 0;
    }
    return true;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export interface VoiceCall {
    on(event: "audio", listener: (pcm: Int16Array) => void): this;
    on(event: "state", listener: (state: CallState) => void): this;
    on(event: "ended", listener: (info: { reason: EndReason; durationMs: number }) => void): this;
    on(event: "error", listener: (error: CallError) => void): this;
    on(event: "remote-mute", listener: (muted: boolean) => void): this;
    once(event: "audio", listener: (pcm: Int16Array) => void): this;
    once(event: "state", listener: (state: CallState) => void): this;
    once(event: "ended", listener: (info: { reason: EndReason; durationMs: number }) => void): this;
    once(event: "error", listener: (error: CallError) => void): this;
    once(event: "remote-mute", listener: (muted: boolean) => void): this;
    off(event: "audio" | "state" | "ended" | "error" | "remote-mute", listener: (...args: never[]) => void): this;
}

/** One 1-to-1 Zalo voice call. Created by a CallController; never construct directly. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export class VoiceCall extends EventEmitter {
    readonly id: string;
    readonly peerId: string;
    readonly direction: CallDirection;
    private readonly offer: ZrtcIncomingOffer | null;
    private _state: CallState;
    private session: AudioSession | null = null;
    private relay: AudioRelay | null = null;
    private security: MediaSecurity | null = null;
    private muted = false;
    private remoteMuted = false;
    private connectedAt = 0;
    private endedDuration = 0;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private answerResend: ReturnType<typeof setInterval> | null = null;
    private answeredLocally = false;
    // outgoing
    private preflight: ZrtcOutgoingPreflight | null = null;
    private outgoingPlan: OutgoingPlan | null = null;
    private answerHandled = false;

    /** @internal */
    constructor(private readonly runtime: CallRuntime, init:
        | { direction: "incoming"; offer: ZrtcIncomingOffer }
        | { direction: "outgoing"; peerId: string; callId: string }) {
        super();
        this.direction = init.direction;
        if (init.direction === "incoming") {
            this.offer = init.offer;
            this.id = String(init.offer.callId);
            this.peerId = init.offer.uidN;
            this._state = "incoming";
        } else {
            this.id = init.callId;
            this.peerId = init.peerId;
            this.offer = null;
            this._state = "dialing";
        }
    }
    get state(): CallState { return this._state; }

    // ------------------------------------------------------------ public API

    async answer(): Promise<void> {
        if (this._state === "ended") return;
        if (this.direction !== "incoming" || this._state !== "incoming")
            throw new CallError("invalid-state", `Cannot answer a call in state "${this._state}"`);
        const offer = this.offer!;
        this.answeredLocally = true;
        this.setState("connecting");
        try {
            const plan = planIncoming(offer);
            this.security = plan.security;
            const relay = await this.openRelay({
                isCaller: false, userId: asUint32(offer.uidTo), partnerId: asUint32(offer.uidFrom),
                callId: offer.callId, sessionId: offer.sessionId, subcommand: 2,
            }, plan.relay);
            if (this.isEnded()) { relay.close(true); return; }
            this.relay = relay;
            this.session = this.createSession(relay, plan.security);
            const payload = plan.buildAnswer(relay.relay);
            this.armTimer(this.runtime.connectTimeoutMs, () => {
                this.emitError(new CallError("timeout", "Peer did not confirm the answer"));
                void this.finish("error", { signal: "end" });
            });
            await this.runtime.signaling.answer(payload);
            this.log("debug", "answer sent", { status: 0 });
            let sends = 1;
            this.answerResend = setInterval(() => {
                if (this._state !== "connecting" || sends >= ANSWER_MAX_SENDS) { this.stopAnswerResend(); return; }
                sends++;
                this.runtime.signaling.answer(payload).catch(error => this.log("warn", "answer resend failed", { error: redactMessage(error) }));
            }, ANSWER_RESEND_MS);
        } catch (error) {
            const callError = toCallError(error, error instanceof CallError ? error.code : "zalo-rejected", "Answer failed");
            if (!this.isEnded()) await this.finish("error", { signal: "none" });
            throw callError;
        }
    }

    async reject(): Promise<void> {
        if (this._state === "ended") return;
        if (this.direction !== "incoming" || this._state !== "incoming")
            throw new CallError("invalid-state", `Cannot reject a call in state "${this._state}"`);
        await this.finish("rejected", { signal: "decline" });
    }

    async hangup(): Promise<void> {
        if (this._state === "ended") return;
        const signal = this._state === "incoming" ? "decline"
            : this.direction === "outgoing" && this._state !== "connected" ? "cancel" : "end";
        await this.finish("local-hangup", { signal });
    }

    setMuted(muted: boolean): void {
        this.muted = Boolean(muted);
        if (this.session) this.session.muted = this.muted;
    }

    writeAudio(pcm: Int16Array): void {
        if (this._state !== "connected" || !this.session || !(pcm instanceof Int16Array)) return;
        this.session.write(pcm);
    }

    stats(): CallStats {
        const counters = this.session?.counters;
        return {
            durationMs: this.durationMs(),
            packetsSent: counters?.packetsSent ?? 0,
            packetsReceived: counters?.packetsReceived ?? 0,
            packetsLost: counters?.packetsLost ?? 0,
            inputRms: this.session?.inputMeter.value ?? 0,
            outputRms: this.session?.outputMeter.value ?? 0,
            remoteMuted: this.remoteMuted,
        };
    }

    /** Extension: detailed transport counters for live diagnosis (no secrets). */
    diagnostics(): Record<string, number | string | boolean | null> {
        return {
            state: this._state, codec: this.security?.codec.name ?? null,
            srtpProfile: this.security?.profile ?? null, srtcp: this.security?.srtcp ?? null,
            remoteMuted: this.remoteMuted, ...(this.session?.counters ?? {}),
        };
    }

    // ------------------------------------------------------ controller hooks

    /** @internal Called once after construction for incoming calls. */
    startIncoming(): void {
        const offer = this.offer!;
        // Safety net: the caller normally cancels well before this.
        this.armTimer(this.runtime.ringTimeoutMs + 30_000, () => {
            if (this._state === "incoming") void this.finish("no-answer", { signal: "none" });
        });
        if (this.runtime.sendRinging)
            this.runtime.signaling.ring(offer.uidN, this.id).catch(error => this.log("warn", "ringring failed", { error: redactMessage(error) }));
    }

    /** @internal Outgoing setup: requestcall → relay → request. */
    async startOutgoing(): Promise<void> {
        const signaling = this.runtime.signaling;
        this.armTimer(this.runtime.ringTimeoutMs, () => {
            if (this._state === "dialing" || this._state === "ringing") void this.finish("no-answer", { signal: "cancel" });
        });
        let response: unknown;
        try { response = await signaling.requestCall({ calleeId: this.peerId, callId: this.id, typeRequest: 1, codec: "[]" }); }
        catch (error) { throw toCallError(error, "zalo-rejected", "requestcall failed"); }
        if (this.isEnded()) return;
        let preflight: ZrtcOutgoingPreflight;
        try { preflight = parseZrtcOutgoingPreflight(response); }
        catch (error) { throw toCallError(error, "zalo-rejected", "Unexpected requestcall response"); }
        if (String(preflight.callId) !== this.id) throw new CallError("zalo-rejected", "requestcall answered for a different call");
        const plan = planOutgoing(preflight);
        this.preflight = preflight;
        this.outgoingPlan = plan;
        let chosen: OutgoingPlan["candidates"][number] | undefined;
        for (const candidate of plan.candidates) {
            try {
                this.relay = await this.openRelay({
                    isCaller: true, userId: plan.localUid, partnerId: plan.remoteUid,
                    callId: preflight.callId, sessionId: preflight.sessionId, subcommand: 2,
                }, candidate.endpoint);
                chosen = candidate;
                break;
            } catch (error) {
                this.log("debug", "relay candidate failed", { error: redactMessage(error) });
            }
            if (this.isEnded()) return;
        }
        if (this.isEnded()) { this.relay?.close(true); this.relay = null; return; }
        if (!chosen || !this.relay) throw new CallError("relay-failed", `No relay accepted registration (${plan.candidates.length} candidates)`);
        try {
            await signaling.request({
                calleeId: this.peerId, callId: this.id, rtpAddress: chosen.rtpAddress, rtcpAddress: chosen.rtcpAddress,
                codec: JSON.stringify([plan.codec.item]), session: preflight.sessionId, extendData: JSON.stringify(plan.capabilities),
            });
        } catch (error) { throw toCallError(error, "zalo-rejected", "request failed"); }
        this.log("debug", "invite sent");
    }

    /** @internal Route a control event that belongs to this call. */
    handleControl(control: CallControl): void {
        if (this._state === "ended") return;
        const act = control.act;
        if (/mute_audio/i.test(act)) {
            const muted = remoteMuteFrom(control);
            this.log("debug", "remote mute control", { act, muted, keys: Object.keys(parseParams(record(control.data))) });
            if (muted !== this.remoteMuted) { this.remoteMuted = muted; this.safeEmit("remote-mute", muted); }
            return;
        }
        if (TERMINAL.has(act)) {
            this.log("debug", "terminal control", { act, status: controlStatus(control) });
            const reason: EndReason = this.direction === "incoming" && this._state === "incoming" ? "cancelled" : "remote-hangup";
            void this.finish(reason, { signal: "none" });
            return;
        }
        if (this.direction === "incoming") {
            if (this._state === "incoming" && (act === "answer" || ACK.has(act))) {
                // PROVISIONAL: another device of this account handled the call.
                const status = controlStatus(control);
                this.log("debug", "control for unanswered incoming call (provisional answered-elsewhere)", { act, status });
                void this.finish(status === DECLINE_STATUS ? "rejected" : "answered-elsewhere", { signal: "none" });
                return;
            }
            if (this._state === "connecting" && ACK.has(act) && this.answeredLocally) this.onConfirmed();
            return;
        }
        // outgoing
        if (RINGING.has(act)) {
            if (this._state === "dialing") this.setState("ringing");
            return;
        }
        if (act === "answer" && !this.answerHandled) {
            this.answerHandled = true;
            void this.onOutgoingAnswer(control);
        }
    }

    /** @internal Listener lost: end without relying on signaling. */
    networkLost(): void {
        if (this._state === "ended") return;
        void this.finish("network", { signal: this._state === "incoming" ? "none" : this.direction === "outgoing" && this._state !== "connected" ? "cancel" : "end" });
    }

    /** @internal Fail an outgoing call whose setup threw. */
    async failSetup(error: CallError): Promise<void> {
        this.log("warn", "outgoing setup failed", { code: error.code, error: error.message });
        await this.finish("error", { signal: this.preflight ? "cancel" : "none" });
    }

    // ------------------------------------------------------------- internals

    private async onOutgoingAnswer(control: CallControl) {
        let answer;
        try { answer = parseZrtcOutgoingAnswer(control.data); }
        catch (error) {
            this.log("warn", "unparseable answer", { error: redactMessage(error) });
            this.emitError(new CallError("internal", "Unparseable answer from peer"));
            await this.finish("error", { signal: "cancel" });
            return;
        }
        if (answer.status !== 0) {
            // Only status 3 (decline) is confirmed. Anything else: report raw code, do not guess.
            this.log("debug", "outgoing call answered with non-zero status", { status: answer.status });
            if (answer.status === DECLINE_STATUS) await this.finish("rejected", { signal: "none" });
            else {
                this.emitError(new CallError("zalo-rejected", `Peer answered with unknown status ${answer.status}`));
                await this.finish("error", { signal: "none" });
            }
            return;
        }
        this.setState("connecting");
        try {
            const security = securityForOutgoingAnswer(this.preflight!, this.outgoingPlan!, answer);
            if (!this.relay) throw new CallError("relay-failed", "Relay closed before answer");
            this.security = security;
            this.session = this.createSession(this.relay, security);
            await this.runtime.signaling.answerAck(this.peerId, this.id);
            if (this.isEnded()) return;
            this.onConfirmed();
        } catch (error) {
            this.emitError(toCallError(error, "internal", "Could not complete the answered call"));
            await this.finish("error", { signal: "end" });
        }
    }

    private onConfirmed() {
        if (this._state !== "connecting" || !this.session) return;
        this.stopAnswerResend();
        this.clearTimers();
        this.connectedAt = Date.now();
        this.session.muted = this.muted;
        this.session.startTransmitting();
        this.setState("connected");
    }

    private createSession(relay: AudioRelay, security: MediaSecurity): AudioSession {
        return new AudioSession(relay, security,
            pcm => this.safeEmit("audio", pcm),
            error => this.emitError(toCallError(error, "internal", "Audio error")));
    }

    private pendingMedia: ((packet: ZrtpRelayMedia) => void) = packet => this.session?.receive(packet);

    private async openRelay(init: Parameters<OpenRelay>[0], endpoint: { address: string; port: number }): Promise<AudioRelay> {
        try {
            return await this.runtime.openRelay(init, endpoint, {
                onMedia: packet => this.pendingMedia(packet),
                onError: error => this.log("warn", "relay socket error", { error: redactMessage(error) }),
            });
        } catch (error) {
            throw toCallError(error, "relay-failed", "Relay registration failed");
        }
    }

    private async finish(reason: EndReason, { signal }: { signal: "none" | "decline" | "cancel" | "end" }): Promise<void> {
        if (this._state === "ended") return;
        const durationMs = this.durationMs();
        this.endedDuration = durationMs;
        this._state = "ended";
        this.stopAnswerResend();
        this.clearTimers();
        const session = this.session, relay = this.relay;
        this.session = null; this.relay = null;
        const sendRelayEnd = signal !== "none" || reason === "network";
        try { if (session) session.close(sendRelayEnd); else relay?.close(sendRelayEnd); }
        catch { /* local cleanup must not throw */ }
        this.security = null;
        this.log("info", "call ended", { reason, durationMs });
        this.safeEmit("state", "ended");
        this.safeEmit("ended", { reason, durationMs });
        try { this.runtime.onEnded(this); } catch { /* controller bookkeeping */ }
        try { await this.sendTeardown(signal); }
        catch (error) {
            this.log("warn", "teardown signal failed", { signal, error: redactMessage(error) });
        }
        this.removeAllListeners("audio");
    }

    private async sendTeardown(signal: "none" | "decline" | "cancel" | "end") {
        const signaling = this.runtime.signaling;
        if (signal === "decline") {
            const offer = this.offer!;
            await signaling.answer({ callerId: offer.uidN, callId: this.id, status: DECLINE_STATUS, session_id: offer.sessionId });
        } else if (signal === "cancel") {
            if (this.preflight) await signaling.cancel(this.peerId, this.id, 1);
        } else if (signal === "end") {
            await signaling.end(this.peerId, this.id);
        }
    }

    private durationMs(): number {
        if (this._state === "ended") return this.endedDuration;
        return this.connectedAt ? Date.now() - this.connectedAt : 0;
    }

    private isEnded() { return this._state === "ended"; }

    private setState(state: CallState) {
        if (this._state === state || this._state === "ended") return;
        this._state = state;
        this.log("debug", "state", { state });
        this.safeEmit("state", state);
    }

    private armTimer(ms: number, fn: () => void) {
        const timer = setTimeout(() => { this.timers.delete(timer); try { fn(); } catch { /* never throw from timers */ } }, ms);
        this.timers.add(timer);
    }
    private clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
    private stopAnswerResend() { if (this.answerResend) clearInterval(this.answerResend); this.answerResend = null; }

    private emitError(error: CallError) {
        this.log("warn", "call error", { code: error.code, error: error.message });
        if (this.listenerCount("error") > 0) this.safeEmit("error", error);
    }

    private safeEmit(event: string, ...args: unknown[]) {
        try { this.emit(event, ...args); }
        catch (error) { this.log("error", `listener for "${event}" threw`, { error: redactMessage(error) }); }
    }

    private log(level: keyof CallLogger, message: string, meta: Record<string, unknown> = {}) {
        try { this.runtime.logger[level]?.(`[call] ${message}`, { callId: this.id, peerId: this.peerId, direction: this.direction, ...meta }); }
        catch { /* logger must not break calls */ }
    }
}
