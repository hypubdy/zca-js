import { test } from "node:test";
import assert from "node:assert/strict";
import { observeCall, restoreCall } from "../web/call-notification.mjs";

test("incoming request is visible before media is started, cancel closes ringing", () => {
    const request = observeCall(null, "request", 1000);
    assert.equal(request.status, "ringing");
    assert.equal(observeCall(request, "unknown-future-action", 1100), request);
    assert.equal(observeCall(request, "cancel", 22000).status, "ended");
});
test("reloading restores call history without resurrecting a cancelled or stale call", () => {
    const log = [
        { event: "incoming-control", time: "2026-10-21T10:14:01.240Z", data: { action: "request" } },
        { event: "incoming-control", time: "2026-10-21T10:14:22.485Z", data: { action: "cancel" } },
    ];
    assert.equal(restoreCall(log).status, "ended");
    assert.equal(restoreCall(log.slice(0, 1), Date.parse(log[0].time) + 60001).status, "stale");
    assert.equal(restoreCall([]), null);
});

test("observed end_call event ends ringing and survives reload", () => {
    assert.equal(observeCall(observeCall(null, "request"), "end_call").status, "ended");
    assert.equal(restoreCall([{event:"incoming-control",time:new Date().toISOString(),data:{action:"end_call"}}]).status,"ended");
});
