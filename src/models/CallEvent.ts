/** Raw desktop VoIP control. Action/data schemas may vary by server version. */
export type CallEvent = {
    act_type: "voip";
    act: string;
    data: unknown;
    [key: string]: unknown;
};

/** Safe summary for diagnosing cmd=601 delivery without exposing call identifiers or payloads. */
export type CallControlBatchSummary = {
    validBatch: boolean;
    controlCount: number | null;
    voipCount: number;
    actions: string[];
};

export function summarizeCallControlBatch(controls: unknown): CallControlBatchSummary {
    if (!Array.isArray(controls)) return { validBatch: false, controlCount: null, voipCount: 0, actions: [] };
    let voipCount = 0;
    const actions = new Set<string>();
    for (const item of controls) {
        if (!item || typeof item !== "object" || !("content" in item)) continue;
        const content = item.content;
        if (!content || typeof content !== "object") continue;
        const { act_type, act } = content as Record<string, unknown>;
        if (act_type === "voip") voipCount++;
        if (typeof act_type === "string" && typeof act === "string") {
            const safeAction = `${act_type}:${act}`;
            if (safeAction.length <= 64 && actions.size < 16) actions.add(safeAction);
        }
    }
    return { validBatch: true, controlCount: controls.length, voipCount, actions: [...actions] };
}
