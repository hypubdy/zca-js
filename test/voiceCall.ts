import { describe, expect, test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { voiceCallFactory } from "../src/apis/voiceCall.js";
import { createContext } from "../src/context.js";
import { decodeAES, encodeAES } from "../src/utils.js";
import type { API } from "../src/apis.js";

function fixture() {
    const ctx = createContext();
    ctx.secretKey = "AAAAAAAAAAAAAAAAAAAAAA==";
    ctx.imei = "test-device";
    ctx.cookie = new CookieJar();
    ctx.userAgent = "offline-test";
    ctx.options.logging = false;
    const requests: { path: string; params: unknown; method?: string }[] = [];
    ctx.options.polyfill = (async (input, options) => {
        const url = new URL(String(input));
        requests.push({
            path: url.pathname,
            params: JSON.parse(decodeAES(ctx.secretKey!, url.searchParams.get("params")!)!),
            method: options?.method,
        });
        return Response.json({ error_code: 0, data: encodeAES(ctx.secretKey!, JSON.stringify({
            error_code: 0, data: { ok: true },
        })) });
    }) as typeof fetch;
    const api = { zpwServiceMap: { voice_call: ["https://offline.invalid"] } } as unknown as API;
    return { call: voiceCallFactory(ctx, api), requests, api };
}

describe("desktop call signaling (offline)", () => {
    test("encrypts GET payloads and resolves encrypted responses", async () => {
        const { call, requests } = fixture();
        expect(await call.ring("caller", "9007199254740993")).toEqual({ ok: true });
        await call.answer({ callerId: "caller", callId: "id", status: 7, codec: "codec",
            rtcpAddress: "rtcp", rtpAddress: "rtp", session_id: "session", extendData: "extended" });
        await call.answerAck("callee", "id");
        await call.requestCall({ calleeId: "callee", callId: "44", typeRequest: 1 });
        await call.request({ calleeId: "callee", callId: "44", rtcpAddress: "relay:4001", rtpAddress: "relay:4000",
            codec: "[]", session: "session", extendData: "{}" });
        await call.cancel("caller", "id", 2);
        await call.end("peer", "id");
        expect(requests).toEqual([
            { method: "GET", path: "/api/voicecall/ringring", params: {
                callerId: "caller", callId: "9007199254740993", status: 0, imei: "test-device" } },
            { method: "GET", path: "/api/voicecall/answer", params: {
                callerId: "caller", callId: "id", status: 7, codec: "codec", rtcpAddress: "rtcp",
                rtpAddress: "rtp", session_id: "session", extendData: "extended", subCommand: 3 } },
            { method: "GET", path: "/api/voicecall/answerack", params: {
                calleeId: "callee", callId: "id", status: 0, imei: "test-device" } },
            { method: "GET", path: "/api/voicecall/requestcall", params: {
                calleeId: "callee", callId: "44", codec: "[]", typeRequest: 1, imei: "test-device" } },
            { method: "GET", path: "/api/voicecall/request", params: {
                calleeId: "callee", rtcpAddress: "relay:4001", rtpAddress: "relay:4000", codec: "[]",
                session: "session", callId: "44", imei: "test-device", extendData: "{}", subCommand: 3 } },
            { method: "GET", path: "/api/voicecall/cancel", params: {
                callerId: "caller", callId: "id", callType: 2, status: 0, imei: "test-device" } },
            { method: "GET", path: "/api/voicecall/endcall", params: {
                uidTo: "peer", callId: "id", status: 3, imei: "test-device" } },
        ]);
    });
    test("rejects invalid identifiers and unavailable service before sending", async () => {
        const { call, requests, api } = fixture();
        await expect(call.end("", "id")).rejects.toThrow("Missing peer id");
        await expect(call.answer({ callerId: "peer", callId: "id", status: NaN })).rejects.toThrow();
        await expect(call.requestCall({ calleeId: "peer", callId: "id", typeRequest: 5 as 1 })).rejects.toThrow("Invalid outgoing call type");
        await expect(call.request({ calleeId: "peer", callId: "id", rtcpAddress: "", rtpAddress: "relay",
            codec: "[]", session: "session" })).rejects.toThrow("Missing rtcpAddress");
        api.zpwServiceMap.voice_call = [];
        await expect(call.ring("peer", "id")).rejects.toThrow("service is not available");
        expect(requests).toHaveLength(0);
    });
});
