/* global location */
export function createBrowserTransport() {
    const listeners = new Set();
    const clientId = crypto.randomUUID();
    let socket;
    let closed = false;
    let retryTimer;

    const publish = (event) => { for (const listener of listeners) listener(event); };
    const connect = () => {
        if (closed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
        socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?clientId=${encodeURIComponent(clientId)}`);
        socket.onopen = () => publish({ type: "connection-state", state: "connected" });
        socket.onmessage = ({ data }) => {
            try {
                const message = JSON.parse(data);
                if (message.event) publish({ type: message.event, ...(message.data || {}) });
            } catch { /* Ignore malformed event frames. */ }
        };
        socket.onclose = () => {
            socket = null;
            publish({ type: "connection-state", state: "disconnected" });
            if (!closed) retryTimer = setTimeout(connect, 1500);
        };
        socket.onerror = () => socket?.close();
    };
    connect();

    return {
        async request(action, payload = {}) {
            const response = await fetch("/api/call", {
                method: "POST", headers: { "content-type": "application/json", "x-call-client-id": clientId },
                credentials: "same-origin", body: JSON.stringify({ action, data: payload }),
            });
            let result;
            try { result = await response.json(); }
            catch { throw new Error(`Backend trả phản hồi không hợp lệ (HTTP ${response.status})`); }
            if (!response.ok || result.ok === false) throw new Error(result.error || `Yêu cầu thất bại (HTTP ${response.status})`);
            return result.data;
        },
        subscribe(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
                if (listeners.size === 0) { closed = true; clearTimeout(retryTimer); socket?.close(); }
            };
        },
        sendRaw(message) {
            if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Kênh media chưa kết nối");
            socket.send(JSON.stringify(message));
        },
        get socket() { return socket; },
    };
}
