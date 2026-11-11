/** Keep outgoing-call failure logs useful without persisting account or call secrets. */
export function safeCallError(error) {
    const source = error && typeof error === "object" ? error : {};
    const errorName = typeof source.name === "string" ? source.name.slice(0, 48) : "Error";
    const rawCode = source.code;
    const errorCode = typeof rawCode === "number" && Number.isFinite(rawCode)
        ? rawCode
        : typeof rawCode === "string" && /^[a-z0-9_-]{1,40}$/i.test(rawCode) ? rawCode : undefined;
    let message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    message = message
        .replace(/\b(session(?:_id|id)?|sessId|token|secret|key|imei|cookie)\b\s*[:=]\s*["']?[^\s,;}'"]+["']?/gi, "$1=[redacted]")
        .replace(/(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?/g, "[address]")
        .replace(/\b[a-z0-9+/_=-]{24,}\b/gi, "[redacted]")
        .replace(/\b\d{7,}\b/g, "[id]")
        .slice(0, 180);
    return { errorName, ...(errorCode === undefined ? {} : { errorCode }), message };
}
