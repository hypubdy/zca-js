import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";

const port = 4321;
const clientId = "00000000-0000-4000-8000-000000000000";
test("HTTP API accepts same-origin JSON commands and rejects bad origin", async (t) => {
    const child = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: "ignore" });
    t.after(() => child.kill("SIGTERM"));
    let response;
    for (let i = 0; i < 50; i++) {
        try {
            response = await fetch(`http://127.0.0.1:${port}/api/call`, {
                method: "POST", headers: { origin: `http://127.0.0.1:${port}`, "x-call-client-id": clientId, "content-type": "application/json" },
                body: JSON.stringify({ action: "zalo.status" }),
            });
            break;
        } catch { await delay(50); }
    }
    assert.ok(response, "server should start");
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data.state, "offline");

    const denied = await fetch(`http://127.0.0.1:${port}/api/call`, {
        method: "POST", headers: { origin: "https://evil.example", "x-call-client-id": clientId, "content-type": "application/json" },
        body: JSON.stringify({ action: "zalo.status" }),
    });
    assert.equal(denied.status, 403);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${clientId}`, { origin: `http://127.0.0.1:${port}` });
    const events = [];
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket upgrade timed out")), 3000);
        ws.on("message", (raw) => {
            events.push(JSON.parse(raw.toString()).event);
            if (events.includes("snapshot")) { clearTimeout(timeout); resolve(); }
        });
        ws.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
    ws.close();
    assert.deepEqual(events.slice(0, 2), ["connection-state", "snapshot"]);
});
