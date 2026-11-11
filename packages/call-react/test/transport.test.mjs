import { test } from "node:test";
import assert from "node:assert/strict";
import { ZaloCallClient, assertCallTransport } from "../src/index.js";

test("custom transport is injected, subscribed, and receives normalized state events", async () => {
    const listeners = new Set();
    const requests = [];
    const transport = {
        request: async (action, payload) => { requests.push({ action, payload }); return { accepted: true }; },
        subscribe: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    };
    const client = new ZaloCallClient({ transport });
    await client.connect();
    assert.equal(client.getSnapshot().gateway, "connected");
    for (const handler of listeners) handler({ type: "call-incoming", callId: "c-1", peerId: "p-1" });
    assert.equal(client.getSnapshot().call, "incoming");
    assert.equal(client.getSnapshot().incoming.callId, "c-1");
    assert.deepEqual(await client.rpc("call-accept", { callId: "c-1" }), { accepted: true });
    assert.deepEqual(requests, [{ action: "call-accept", payload: { callId: "c-1" } }]);
    client.destroy();
    assert.equal(listeners.size, 0);
});

test("transport validation requires app request and event subscription only", () => {
    assert.throws(() => assertCallTransport({}), /request.*subscribe/);
    const valid = { request() {}, subscribe() {} };
    assert.equal(assertCallTransport(valid), valid);
});
