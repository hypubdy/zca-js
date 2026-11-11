// rollup.config.js
import { isAbsolute } from "node:path";

export default {
    input: {
        index: "dist/index.js",
        "call/voice": "dist/call/voice.js",
        "call/webrtc": "dist/call/webrtc.js",
    },
    output: {
        dir: "dist/cjs",
        entryFileNames: "[name].cjs",
        format: "cjs",
        preserveModules: true,
        preserveModulesRoot: "dist",
    },
    // Every bare import (dependencies, optional peers, node builtins) stays external.
    external: (id) => !id.startsWith(".") && !isAbsolute(id),
};
