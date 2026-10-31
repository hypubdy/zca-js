/**
 * WebSocket transport for the call gateway.
 *
 * Owns RPC correlation, reconnection and the raw event channel; it knows
 * nothing about calls, media or React. Callbacks:
 *   - onStatus(patch)          gateway state patches for the store
 *   - onEvent(event, data)     server-pushed events
 *   - onClose()                socket lost / closed; caller tears down media
 */
export class GatewayTransport {
    constructor({ url, rpcTimeoutMs, reconnectMs, autoReconnect, WebSocketImpl, onStatus, onEvent, onClose }) {
        this.url = url;
        this.rpcTimeoutMs = rpcTimeoutMs;
        this.reconnectMs = reconnectMs;
        this.autoReconnect = autoReconnect;
        this.WebSocketImpl = WebSocketImpl;
        this.onStatus = onStatus;
        this.onEvent = onEvent;
        this.onClose = onClose;
        this.socket = null;
        this.pending = new Map();
        this.sequence = 0;
        this.connectPromise = null;
        this.connectReject = null;
        this.reconnectTimer = null;
        this.closedByUser = false;
    }

    get isOpen() {
        return this.socket?.readyState === this.WebSocketImpl?.OPEN;
    }

    async connect() {
        if (this.isOpen) return;
        if (this.connectPromise) return this.connectPromise;
        if (!this.WebSocketImpl) throw new Error("WebSocket is not available");
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.onStatus({ gateway: "connecting", error: null });
        this.connectPromise = new Promise((resolve, reject) => {
            this.connectReject = reject;
            const socket = new this.WebSocketImpl(this.url);
            this.socket = socket;
            let opened = false;
            socket.onopen = () => {
                opened = true;
                this.connectPromise = null;
                this.connectReject = null;
                this.onStatus({ gateway: "connected", error: null });
                resolve();
            };
            socket.onmessage = (message) => this.handleMessage(message.data);
            socket.onerror = () => {
                if (opened) return;
                this.connectPromise = null;
                this.connectReject = null;
                reject(new Error("Cannot connect to the call gateway"));
            };
            socket.onclose = () => {
                if (!opened) reject(new Error("Call gateway closed before connecting"));
                if (this.socket !== socket) return;
                this.socket = null;
                this.connectPromise = null;
                this.connectReject = null;
                this.rejectPending(new Error("Call gateway disconnected"));
                this.onStatus({ gateway: "disconnected", call: "idle", direction: null, media: "idle" });
                this.onClose?.();
                if (!this.closedByUser && this.autoReconnect) {
                    this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), this.reconnectMs);
                }
            };
        });
        return this.connectPromise;
    }

    disconnect() {
        this.closedByUser = true;
        clearTimeout(this.reconnectTimer);
        this.connectReject?.(new Error("Call client disconnected"));
        this.connectReject = null;
        this.connectPromise = null;
        this.rejectPending(new Error("Call client disconnected"));
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this.onStatus({ gateway: "disconnected", call: "idle", direction: null, media: "idle" });
    }

    rejectPending(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timeout);
            request.reject(error);
        }
        this.pending.clear();
    }

    /** Request/response over the gateway; resolves with the RPC `data`. */
    rpc(action, data = {}) {
        if (!this.isOpen) return Promise.reject(new Error("Call gateway is not connected"));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${action} timed out`));
            }, this.rpcTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
            try {
                this.socket.send(JSON.stringify({ id, action, data }));
            } catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    /** Fire-and-forget message (video frames, telemetry). */
    sendRaw(message) {
        if (!this.isOpen) throw new Error("Call gateway is not connected");
        this.socket.send(JSON.stringify(message));
    }

    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
            return;
        }
        if (message.id !== undefined && message.id !== null) {
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            clearTimeout(request.timeout);
            if (message.ok) request.resolve(message.data);
            else request.reject(new Error(message.error || "Gateway RPC failed"));
            return;
        }
        if (message.event) this.onEvent(message.event, message.data || {});
    }
}
