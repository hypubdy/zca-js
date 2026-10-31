import { describe, expect, test } from "bun:test";
import { buildZrtcVideoCapabilities, ZRTC_NATIVE_H264_VIDEO_CODEC } from "../src/call/index.js";
describe("native video signaling capability", () => {
    test("uses the observed H264 capability and explicit video call type", () => {
        expect(ZRTC_NATIVE_H264_VIDEO_CODEC).toEqual({name:"h264", payload:97});
        expect(buildZrtcVideoCapabilities({srtpMode:1,srtcp:0,packetMode:2})).toMatchObject({
            callType:1, video:{codec:[{name:"h264",payload:97}]}, srtpMode:1, srtcp:0, packetMode:2,
        });
    });
});
