import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallBackend } from "../src/call-backend.mjs";

test("server backend exposes safe offline state and rejects Zalo actions before login", async () => {
    const events = [];
    const backend = createCallBackend({ publish: (event, data) => events.push({ event, data }), iceServers: [] });
    assert.equal(backend.snapshot().zalo, "offline");
    await assert.rejects(backend.handle("friends.list"), /Kết nối tài khoản Zalo/);
    assert.deepEqual(events, []);
    await backend.close();
});

test("unknown server actions are rejected explicitly", async () => {
    const backend = createCallBackend({ publish() {}, iceServers: [] });
    await assert.rejects(backend.handle("unknown"), /Yêu cầu không được hỗ trợ/);
    await backend.close();
});
