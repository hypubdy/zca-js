import { describe, expect, test } from "bun:test";
import { parseZrtcIncomingOffer, parseZrtcOutgoingPreflight, parseZrtcOutgoingAnswer, parseZrtcAudioCodecs, buildZrtcAcceptedAnswer } from "../src/call/negotiation.js";
import { selectZrtcSrtpKey, negotiateZrtcSrtpMode } from "../src/call/srtpParameters.js";

const incoming = () => ({uidFrom:"123",uidTo:"456",uidN:"peer-noise-id",ts:"1792584000000",params:JSON.stringify({id:0x11223344,platform:2,protocol:1,
    sessId:"synthetic-session-01234567890123456789",rtpIP:"127.0.0.1:1234",rtcpIP:"127.0.0.1:1235",codec:'[{"name":"opus","payload":112,"frmPtime":20,"dynamicFptime":0}]',
    servers:[],zrtc_config:{srtpMode:1}})});
describe("independent negotiation schemas (static fixtures only)", () => {
    test("parses native 401 preflight fields while retaining secrets only in the backend object", () => {
        const parsed = parseZrtcOutgoingPreflight({ status: 0, fromId: -12, toId: 34, id: 55,
            protocol: 1, sessId: "private-session", zrtc_config: { srtpMode: 1, srtpKey: "private-key" },
            servers: [{ rtpaddr: "127.0.0.1:1000", rtcpaddr: "127.0.0.1:1001",
                relayTime: 17, sent: "service-metadata", recv: null }] });
        expect(parsed.callId).toBe(55);
        expect(parsed.fromId).toBe(-12);
        expect(parsed.toId).toBe(34);
        expect(parsed.servers[0]?.rtpAddress).toBe("127.0.0.1:1000");
        expect(parsed.servers[0]?.relayTime).toBe(17);
        expect(parsed.zrtcConfig.srtpKey).toBe("private-key");
        expect(() => parseZrtcOutgoingPreflight({ id: 1, status: "0", fromId: 2, toId: 3, protocol: 1,
            sessId: "session" })).toThrow("status must be an int32");
        expect(parseZrtcOutgoingPreflight({ status: 0, fromId: 1, toId: 2, id: 55, protocol: 1,
            sessId: "session", servers: [{ rtpaddr: "x", rtcpaddr: "y", sent: "ignored", recv: null }] })
            .servers[0]?.relayTime).toBe(0);
        expect(() => parseZrtcOutgoingPreflight({ status: 0, fromId: 1, toId: 2, id: 55, protocol: 1,
            sessId: "session", servers: [{ rtpaddr: "x", rtcpaddr: "y", relayTime: "17" }] }))
            .toThrow("relayTime");
    });
    test("parses caller answer envelope and nested media fields without treating it as confirmed", () => {
        const parsed = parseZrtcOutgoingAnswer({ callId: "55", status: "0",
            params: JSON.stringify({ platform: 2, codec: '[{"name":"opus/16000/1","payload":112,"frmPtime":20}]',
                extendData: JSON.stringify({ srtpMode: 1, srtcp: 0, private: "must-not-log" }) }) });
        expect(parsed).toEqual({ callId: 55, status: 0, platform: 2,
            codecs: [{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }],
            extendData: '{"srtpMode":1,"srtcp":0,"private":"must-not-log"}' });
        expect(() => parseZrtcOutgoingAnswer({ callId: 55, status: 0, params: "{}" })).toThrow("codec");
    });
    test("reads callId inside nested params rather than inventing an outer callId", () => {
        const parsed = parseZrtcIncomingOffer(incoming());
        expect(parsed.callId).toBe(0x11223344);
        expect(parsed.platform).toBe(2);
        expect(parsed.protocol).toBe(1);
        expect(parsed.codecs).toEqual([{name:"opus",payload:112,frmPtime:20,dynamicFptime:0}]);
        expect(parsed.rtpAddress).toBe("127.0.0.1:1234");
    });
    test("rejects incomplete/unsupported offers before any networking can happen", () => {
        expect(() => parseZrtcIncomingOffer({...incoming(),params:"{}"})).toThrow("params.id");
        expect(() => parseZrtcIncomingOffer({...incoming(),params:incoming()})).toThrow("JSON text");
        expect(() => parseZrtcAudioCodecs('{"name":"opus"}')).toThrow("array");
        expect(parseZrtcAudioCodecs('[{"name":"opus"}]')[0].payload).toBe(0);
        expect(() => parseZrtcAudioCodecs('[{"name":"opus","payload":"112"}]')).toThrow("int32");
    });
    test("native platform/protocol are int32, not strings or SDP protocol names", () => {
        const event = incoming();
        const params = JSON.parse(event.params);
        expect(() => parseZrtcIncomingOffer({...event,params:JSON.stringify({...params,platform:"2"})})).toThrow("platform");
        expect(() => parseZrtcIncomingOffer({...event,params:JSON.stringify({...params,protocol:1.5})})).toThrow("protocol");
    });
    test("accepted 402 body uses explicit selected relay and generated capabilities", () => {
        const offer = parseZrtcIncomingOffer(incoming());
        const answer = buildZrtcAcceptedAnswer({
            offer,
            codecs: [{ name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 }],
            rtpAddress: "198.51.100.10:10000",
            rtcpAddress: "198.51.100.10:10001",
            capabilities: { platform: 2, srtpMode: 1, srtcp: 0 },
        });
        expect(answer).toEqual({
            callerId: "peer-noise-id", callId: String(0x11223344), status: 0,
            codec: '[{"name":"opus/16000/1","payload":112,"frmPtime":20,"dynamicFptime":0}]',
            rtpAddress: "198.51.100.10:10000", rtcpAddress: "198.51.100.10:10001",
            session_id: "synthetic-session-01234567890123456789",
            session: "synthetic-session-01234567890123456789",
            extendData: '{"platform":2,"srtpMode":1,"srtcp":0}',
        });
        expect(() => buildZrtcAcceptedAnswer({ offer, codecs: [], rtpAddress: "a", rtcpAddress: "b", capabilities: {} })).toThrow("negotiated codecs");
        expect(() => buildZrtcAcceptedAnswer({ offer, codecs: [{ name: "opus", payload: 112, frmPtime: 20, dynamicFptime: 0 }],
            rtpAddress: "a", rtcpAddress: "b", capabilities: undefined as unknown as Record<string, unknown> })).toThrow("Generated local capabilities");
    });
    test("SRTP uses raw byte prefix, explicit key wins, and mode must match", () => {
        const session="012345678901234567890123456789EXTRA";
        expect(Buffer.from(selectZrtcSrtpKey(1,session)).toString()).toBe(session.slice(0,30));
        const explicit="abcdefghijklmnopqrstuvwxyz1234";
        expect(Buffer.from(selectZrtcSrtpKey(2,session,explicit)).toString()).toBe(explicit);
        expect(selectZrtcSrtpKey(3,"é".repeat(20)).length).toBe(30);
        expect(() => selectZrtcSrtpKey(1,"short")).toThrow("30");
        expect(() => selectZrtcSrtpKey(4,session)).toThrow("mode");
        expect(negotiateZrtcSrtpMode(2,2)).toBe(2);
        expect(negotiateZrtcSrtpMode(1,2)).toBe(0);
        expect(negotiateZrtcSrtpMode(9,9)).toBe(0);
    });
});
