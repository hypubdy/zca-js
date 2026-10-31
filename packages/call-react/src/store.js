import { TERMINAL_ACTIONS } from "./constants.js";

/**
 * Tiny observable store: immutable snapshot + sync listeners + event channel.
 * `getSnapshot` and `subscribe` are stable arrow properties so they can be
 * passed directly to React's useSyncExternalStore.
 */
export class CallStore {
    constructor(initial) {
        this.state = { ...initial };
        this.listeners = new Set();
        this.eventListeners = new Set();
    }

    getSnapshot = () => this.state;

    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    onEvent = (listener) => {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    };

    update(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }

    emit(event, data) {
        this.update({ lastEvent: { event, data, at: Date.now() } });
        for (const listener of this.eventListeners) listener(event, data);
    }

    clear() {
        this.listeners.clear();
        this.eventListeners.clear();
    }
}

/** Rebuild a pending incoming call from the gateway event log. */
export function restoreIncoming(log) {
    let incoming = null;
    for (const entry of log || []) {
        if (entry.event !== "incoming-control") continue;
        const action = entry.data?.action;
        const at = Date.parse(entry.time);
        if (["request", "group_request"].includes(action)) incoming = { action, at, status: "ringing" };
        else if (TERMINAL_ACTIONS.has(action)) incoming = null;
    }
    if (incoming && (!Number.isFinite(incoming.at) || Date.now() - incoming.at > 60000)) return null;
    return incoming;
}
