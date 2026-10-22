import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("The ZaloCall audio worker requires macOS.");
const directory = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory, ".runtime", "process-tap");
mkdirSync(path.dirname(target), { recursive: true });
const plist = `${target}.Info.plist`;
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.zcajs.call-process-tap</string>
<key>CFBundleName</key><string>ZCA Call Audio</string>
<key>NSAudioCaptureUsageDescription</key><string>Stream audio from the selected Zalo call helper to your browser during a call.</string>
</dict></plist>`);
const result = spawnSync(
    "clang++",
    [
        "-std=c++17",
        "-fobjc-arc",
        "-mmacosx-version-min=14.2",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        path.join(directory, "native", "process-tap.mm"),
        "-framework",
        "CoreAudio",
        "-framework",
        "Foundation",
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
        "-o",
        target,
    ],
    { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(target);
