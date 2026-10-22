import { describe, expect, test } from "bun:test";
import { summarizeCallControlBatch } from "../src/models/CallEvent.js";

describe("safe call-control diagnostics", () => {
    test("summarizes cmd=601 controls without retaining payload fields", () => {
        const summary = summarizeCallControlBatch([
            { content: { act_type: "voip", act: "request", data: { uidN: "private-id", params: "private-session" } } },
            { content: { act_type: "group", act: "join", data: { uid: "private-id" } } },
            { content: { act_type: "voip", act: "answer" } },
        ]);
        expect(summary).toEqual({ validBatch: true, controlCount: 3, voipCount: 2,
            actions: ["voip:request", "group:join", "voip:answer"] });
        expect(JSON.stringify(summary)).not.toContain("private-id");
        expect(JSON.stringify(summary)).not.toContain("private-session");
    });

    test("marks malformed batches and bounds unique action names", () => {
        expect(summarizeCallControlBatch(null)).toEqual({ validBatch: false, controlCount: null, voipCount: 0, actions: [] });
        const summary = summarizeCallControlBatch(Array.from({ length: 20 }, (_, i) => ({ content: {
            act_type: "voip", act: `action-${i}`,
        } })));
        expect(summary.controlCount).toBe(20);
        expect(summary.voipCount).toBe(20);
        expect(summary.actions).toHaveLength(16);
    });
});
