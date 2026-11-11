import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { parseZrtcIncomingOffer } from "../negotiation.js";
import { ZrtpRelaySession } from "../relayRegistration.js";
import { CallError, redactMessage, toCallError } from "./errors.js";
import type { CallControllerOptions, CallLogger, IncomingUnsupportedInfo, OpenRelay } from "./types.js";
import { controlCallId, VoiceCall, type CallControl, type CallRuntime } from "./voiceCall.js";

const defaultOpenRelay: OpenRelay = (init, relay, handlers) =>
    ZrtpRelaySession.open(init, relay, { onMedia: handlers.onMedia, onError: handlers.onError });

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export interface CallController {
    on(event: "incoming", listener: (call: VoiceCall) => void): this;
    on(event: "incoming-unsupported", listener: (info: IncomingUnsupportedInfo) => void): this;
    once(event: "incoming", listener: (call: VoiceCall) => void): this;
    once(event: "incoming-unsupported", listener: (info: IncomingUnsupportedInfo) => void): this;
    off(event: "incoming" | "incoming-unsupported", listener: (...args: never[]) => void): this;
}

/**
 * One controller per logged-in Zalo account. Reuses the account's `api` and
 * started `listener`; never logs in, opens a second listener, reads env or
 * writes files. At most one call is active at a time.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- typed event overloads
export class CallController extends EventEmitter {
    private current: VoiceCall | null = null;
    private destroyed = false;
    private readonly ignored = new Map<string, number>();
    private readonly runtime: CallRuntime;
    private readonly logger: CallLogger;
    private readonly onCall = (control: unknown) => this.safely(() => this.handleControl(control));
    private readonly onLost = () => this.safely(() => {
        this.log("warn", "listener disconnected; ending active call");
        this.current?.networkLost();
    });

    constructor(private readonly options: CallControllerOptions) {
        super();
        if (!options || !options.api?.voiceCall) throw new CallError("internal", "createCallController requires a logged-in api");
        if (!options.listener || typeof options.listener.on !== "function") throw new CallError("internal", "createCallController requires api.listener");
        this.logger = options.logger ?? {};
        const ringTimeoutMs = options.ringTimeoutMs ?? 60_000;
        if (!Number.isFinite(ringTimeoutMs) || ringTimeoutMs < 1000) throw new CallError("internal", "ringTimeoutMs must be ≥ 1000");
        this.runtime = {
            signaling: options.api.voiceCall,
            logger: this.logger,
            openRelay: options.openRelay ?? defaultOpenRelay,
            ringTimeoutMs,
            connectTimeoutMs: options.connectTimeoutMs ?? 20_000,
            sendRinging: options.sendRinging ?? true,
            onEnded: call => { if (this.current === call) this.current = null; },
        };
        options.listener.on("call", this.onCall);
        options.listener.on("disconnected", this.onLost);
        options.listener.on("closed", this.onLost);
    }

    active(): VoiceCall | null { return this.current; }

    async dial(peerId: string): Promise<VoiceCall> {
        if (this.destroyed) throw new CallError("invalid-state", "Controller is destroyed");
        if (typeof peerId !== "string" || !/^\d{1,32}$/.test(peerId)) throw new CallError("invalid-peer", "peerId must be a numeric Zalo UID");
        if (this.current) throw new CallError("busy", "Another call is already active");
        const call = new VoiceCall(this.runtime, { direction: "outgoing", peerId, callId: String(randomInt(1, 0x7fffffff)) });
        this.current = call;
        try {
            await call.startOutgoing();
        } catch (error) {
            const callError = toCallError(error, "internal");
            await call.failSetup(callError);
            throw callError;
        }
        return call;
    }

    async destroy(): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;
        this.options.listener.off("call", this.onCall);
        this.options.listener.off("disconnected", this.onLost);
        this.options.listener.off("closed", this.onLost);
        const call = this.current;
        this.current = null;
        if (call) await call.hangup().catch(() => undefined);
        this.ignored.clear();
        this.removeAllListeners();
    }

    private handleControl(raw: unknown) {
        if (this.destroyed || !raw || typeof raw !== "object") return;
        const control = raw as CallControl;
        if (typeof control.act !== "string") return;
        const act = control.act;
        const callId = controlCallId(control);
        if (callId && this.ignored.has(callId)) return;
        if (act === "group_request" || act.startsWith("group_")) {
            if (act === "group_request") this.ignore("group", control, callId);
            return;
        }
        if (act === "request") { this.handleRequest(control); return; }
        const call = this.current;
        if (!call) return;
        if (callId !== undefined && callId !== call.id) {
            this.log("debug", "control for another call ignored", { act, callId });
            return;
        }
        call.handleControl(control);
    }

    private handleRequest(control: CallControl) {
        let offer;
        try { offer = parseZrtcIncomingOffer(control.data); }
        catch (error) {
            this.log("warn", "unparseable incoming offer ignored", { error: redactMessage(error) });
            return;
        }
        const callId = String(offer.callId);
        if (this.current?.id === callId) return;
        if (offer.videoRequested === true) { this.ignore("video", control, callId, offer.uidN); return; }
        if (this.current) {
            // Leave the call to the user's other devices; do not answer or reject.
            this.log("info", "incoming call while busy ignored", { callId, peerId: offer.uidN });
            return;
        }
        const call = new VoiceCall(this.runtime, { direction: "incoming", offer });
        this.current = call;
        call.startIncoming();
        this.log("info", "incoming voice call", { callId, peerId: call.peerId });
        this.emitSafely("incoming", call);
    }

    private ignore(kind: "video" | "group", control: CallControl, callId: string | undefined, peerId?: string) {
        const data = (control.data && typeof control.data === "object" ? control.data : {}) as Record<string, unknown>;
        const peer = peerId ?? String(data.uidN ?? data.uidFrom ?? data.fromId ?? "");
        const id = callId ?? "";
        if (id) {
            this.ignored.set(id, Date.now());
            if (this.ignored.size > 64) this.ignored.delete(this.ignored.keys().next().value!);
        }
        this.log("info", "unsupported incoming call ignored", { kind, callId: id, peerId: peer });
        this.emitSafely("incoming-unsupported", { peerId: peer, callId: id, kind } satisfies IncomingUnsupportedInfo);
    }

    private emitSafely(event: string, value: unknown) {
        try { this.emit(event, value); }
        catch (error) { this.log("error", `listener for "${event}" threw`, { error: redactMessage(error) }); }
    }

    private safely(fn: () => void) {
        try { fn(); } catch (error) { this.log("error", "call control handler failed", { error: redactMessage(error) }); }
    }

    private log(level: keyof CallLogger, message: string, meta: Record<string, unknown> = {}) {
        try { this.logger[level]?.(`[call] ${message}`, meta); } catch { /* ignore */ }
    }
}

export function createCallController(options: CallControllerOptions): CallController {
    return new CallController(options);
}
