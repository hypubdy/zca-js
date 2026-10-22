import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("The ZaloCall audio worker requires macOS.");
const directory = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory, ".runtime", "pcm-bridge");
mkdirSync(path.dirname(target), { recursive: true });
const result = spawnSync(
    "clang",
    [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        path.join(directory, "native", "pcm-bridge.c"),
        "-framework",
        "CoreAudio",
        "-framework",
        "CoreFoundation",
        "-lpthread",
        "-o",
        target,
    ],
    { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(target);
