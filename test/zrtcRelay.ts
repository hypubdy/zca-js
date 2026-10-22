import { describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import { buildZrtpRelayInit, parseZrtpRelayResponse, probeZrtpRelay } from "../src/call/relayRegistration.js";
import { decodeZrtpPacket, encodeZrtpPacket } from "../src/call/zrtpPacket.js";
const init = {isCaller:false,userId:0x01020304,partnerId:0x05060708,callId:0x11223344,sessionId:"test",subcommand:2 as const};
describe("independent relay registration (offline fixtures and localhost)", () => {
    test("init bytes match hand-transcribed native writes including length and role", () => {
        expect(Buffer.from(buildZrtpRelayInit(init)).toString("hex")).toBe("017e000000000000000004030201000000000c00024433221108070605040074657374");
    });
    test("successful response bounds server data, nonzero status has no token", () => {
        const p = {kind:"control" as const,type:2 as const,version:126,field0c:0,field10:0,field14:0,token:0,command:12,subcommand:0,
            payload:Buffer.from("0000000044332211efbeadde0300616263","hex")};
        expect(parseZrtpRelayResponse(p)).toEqual({status:0,field38:0x11223344,token:0xdeadbeef,serverData:Uint8Array.from([97,98,99])});
        expect(()=>parseZrtpRelayResponse({...p,payload:p.payload.subarray(0,15)})).toThrow("Truncated");
        expect(parseZrtpRelayResponse({...p,payload:Uint8Array.from([1,0,0,0])})).toEqual({status:1});
    });
    test("a Node UDP fixture exchanges init/response with no native engine", async () => {
        const server=dgram.createSocket("udp4");
        await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.bind(0,"127.0.0.1",resolve);});
        const address=server.address();
        const observed:unknown[]=[];
        server.on("message",(bytes,remote)=>{
            const packet=decodeZrtpPacket(bytes); observed.push(packet);
            if(packet.kind!=="control")return;
            const payload=Buffer.from("0000000044332211efbeadde0000","hex");
            server.send(encodeZrtpPacket({...packet,type:2,payload}),remote.port,remote.address);
        });
        try {
            const result=await probeZrtpRelay(init,{address:"127.0.0.1",port:address.port});
            expect(result.token).toBe(0xdeadbeef);
            expect(observed).toHaveLength(1);
        } finally {server.close();}
    });
});
