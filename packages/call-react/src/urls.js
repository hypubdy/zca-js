/** Gateway URL helpers shared by the transport and media session. */

export function requireBrowserUrl(value, fallbackPath) {
    if (value) {
        const base = globalThis.location?.href;
        return new URL(value, base).toString();
    }
    if (!globalThis.location) throw new Error(`${fallbackPath} URL is required outside a browser`);
    return new URL(fallbackPath, globalThis.location.href).toString();
}

/** Resolve the WebSocket endpoint (/ws by default) to a ws:// or wss:// URL. */
export function websocketUrl(value) {
    const url = new URL(requireBrowserUrl(value, "/ws"));
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("gatewayUrl must use ws, wss, http or https");
    return url.toString();
}

/** Resolve the ICE configuration endpoint from the gateway origin. */
export function configUrl(value, resolvedGatewayUrl) {
    if (value) return requireBrowserUrl(value, "/api/config");
    const url = new URL(resolvedGatewayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/api/config";
    url.search = "";
    url.hash = "";
    return url.toString();
}
