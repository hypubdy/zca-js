import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root, ".runtime"), { recursive: true });
const result = spawnSync("clang", ["-fobjc-arc", path.join(root, "native/helper-ui.m"), "-framework", "Foundation", "-framework", "ApplicationServices", "-o", path.join(root, ".runtime/helper-ui")], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
