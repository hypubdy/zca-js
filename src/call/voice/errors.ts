export type CallErrorCode =
    | "busy"
    | "not-connected"
    | "invalid-peer"
    | "invalid-state"
    | "zalo-rejected"
    | "relay-failed"
    | "timeout"
    | "internal";

/** Error raised by the voice-call API. Messages never contain keys, IPs or session data. */
export class CallError extends Error {
    readonly code: CallErrorCode;
    constructor(code: CallErrorCode, message: string) {
        super(message);
        this.name = "CallError";
        this.code = code;
    }
}

/**
 * Reduce an arbitrary thrown value to a short message that is safe to log:
 * strips IP addresses, long tokens, key/session assignments and long numbers
 * (UIDs/call IDs are allowed by the contract but are stripped here as well,
 * because upstream messages may embed other numeric identifiers).
 */
export function redactMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    message = message
        .replace(/\b(session(?:_id|id)?|sessId|token|secret|key|imei|cookie|srtpKey)\b\s*[:=]\s*["']?[^\s,;}'"]+["']?/gi, "$1=[redacted]")
        .replace(/\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\]?(?::\d{1,5})?/gi, "[address]")
        .replace(/(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/g, "[address]")
        .replace(/\b[a-z0-9+/_=-]{24,}\b/gi, "[redacted]")
        .replace(/\b\d{10,}\b/g, "[id]");
    return message.slice(0, 200);
}

export function toCallError(error: unknown, code: CallErrorCode, prefix?: string): CallError {
    if (error instanceof CallError) return error;
    const message = redactMessage(error);
    return new CallError(code, prefix ? `${prefix}: ${message}` : message);
}
