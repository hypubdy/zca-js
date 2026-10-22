// UI observation only: this state never answers, rejects or claims connected media.
export function observeCall(previous, action, at = Date.now()) {
    if (["request", "group_request"].includes(action)) return { status: "ringing", at, action };
    if (["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"].includes(action))
        return { status: "ended", at, action };
    return previous;
}
export function restoreCall(log, now = Date.now()) {
    let state = null;
    for (const event of log || [])
        if (event.event === "incoming-control") {
            const at = Date.parse(event.time);
            if (Number.isFinite(at)) state = observeCall(state, event.data?.action, at);
        }
    if (state?.status === "ringing" && now - state.at > 60000) return { ...state, status: "stale" };
    return state;
}
