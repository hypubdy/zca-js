/** Minimal application-supplied call transport; it has no account credential API. */
export class CallTransport {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    request(_action, _payload) { throw new Error("Implement CallTransport.request(action, payload)"); }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    subscribe(_handler) { throw new Error("Implement CallTransport.subscribe(handler)"); }
}

/** Optional adapter for the repository demo's WebSocket gateway protocol. */
export class GatewayTransport {
    constructor({ url, rpcTimeoutMs, reconnectMs, autoReconnect, WebSocketImpl, onStatus, onEvent, onClose }) {
        Object.assign(this, { url, rpcTimeoutMs, reconnectMs, autoReconnect, WebSocketImpl, onStatus, onEvent, onClose });
        this.socket = null; this.pending = new Map(); this.sequence = 0; this.connectPromise = null;
        this.connectReject = null; this.reconnectTimer = null; this.closedByUser = false; this.listeners = new Set();
    }
    get isOpen() { return this.socket?.readyState === this.WebSocketImpl?.OPEN; }
    async connect() {
        if (this.isOpen) return;
        if (this.connectPromise) return this.connectPromise;
        if (!this.WebSocketImpl) throw new Error("WebSocket is not available");
        this.closedByUser = false; clearTimeout(this.reconnectTimer); this.onStatus({ gateway: "connecting", error: null });
        this.connectPromise = new Promise((resolve, reject) => {
            this.connectReject = reject; const socket = new this.WebSocketImpl(this.url); this.socket = socket; let opened = false;
            socket.onopen = () => { opened = true; this.connectPromise = null; this.connectReject = null; this.onStatus({ gateway: "connected", error: null }); resolve(); };
            socket.onmessage = (message) => this.handleMessage(message.data);
            socket.onerror = () => { if (!opened) { this.connectPromise = null; this.connectReject = null; reject(new Error("Cannot connect to call service")); } };
            socket.onclose = () => {
                if (!opened) reject(new Error("Call service closed before connecting"));
                if (this.socket !== socket) return;
                this.socket = null; this.connectPromise = null; this.connectReject = null; this.rejectPending(new Error("Call service disconnected"));
                this.onStatus({ gateway: "disconnected", call: "idle", direction: null, media: "idle" }); this.onClose?.();
                if (!this.closedByUser && this.autoReconnect) this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), this.reconnectMs);
            };
        });
        return this.connectPromise;
    }
    disconnect() {
        this.closedByUser = true; clearTimeout(this.reconnectTimer); this.connectReject?.(new Error("Call client disconnected"));
        this.connectReject = null; this.connectPromise = null; this.rejectPending(new Error("Call client disconnected"));
        const socket = this.socket; this.socket = null; socket?.close(); this.onStatus({ gateway: "disconnected", call: "idle", direction: null, media: "idle" });
    }
    rejectPending(error) { for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); } this.pending.clear(); }
    request(action, payload = {}) { return this.rpc(action, payload); }
    rpc(action, data = {}) {
        if (!this.isOpen) return Promise.reject(new Error("Call service is not connected"));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${action} timed out`)); }, this.rpcTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
            try { this.socket.send(JSON.stringify({ id, action, data })); }
            catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
        });
    }
    sendRaw(message) { if (!this.isOpen) throw new Error("Call service is not connected"); this.socket.send(JSON.stringify(message)); }
    handleMessage(raw) {
        let message; try { message = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
        if (message.id !== undefined && message.id !== null) {
            const request = this.pending.get(message.id); if (!request) return;
            this.pending.delete(message.id); clearTimeout(request.timeout);
            if (message.ok) request.resolve(message.data); else request.reject(new Error(message.error || "Call service request failed")); return;
        }
        if (message.event) {
            const data = message.data || {}; this.onEvent(message.event, data);
            for (const listener of this.listeners) listener({ type: message.event, ...data });
        }
    }
    subscribe(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
}

export function assertCallTransport(transport) {
    if (!transport || typeof transport.request !== "function" || typeof transport.subscribe !== "function")
        throw new TypeError("transport must implement request(action, payload) and subscribe(handler)");
    return transport;
}
export function transportRequest(transport, action, payload) {
    if (transport instanceof GatewayTransport) {
        const legacy = { "call.prepare": "call-outgoing-preflight", "call.start": "call-outgoing-invite", "call.prepare-media": "call-relay-connect", "call.accept": "call-accept", "call.end": "call-end", "media.negotiate": "media-offer", "media.request-keyframe": "video-pli" }[action] || action;
        if (action === "call.prepare" || action === "call.start") payload = { calleeId: payload.peerId, callType: payload.mediaType === "video" ? 3 : 1 };
        else if (action === "media.negotiate") payload = { ...payload, mode: "zalo", input: "mic" };
        else if (action === "media.stats") {
            transport.sendRaw({ event: "video-client-stats", data: payload });
            return Promise.resolve({ sent: true });
        }
        return transport.rpc(legacy, payload);
    }
    return transport.request(action, payload);
}
