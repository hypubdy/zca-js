import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, "dist"), { recursive: true });
await mkdir(path.join(root, "dist", "call-engine"), { recursive: true });
await build({
    absWorkingDir: root,
    entryPoints: ["../../src/call/*.ts"],
    outbase: "../../src/call",
    outdir: "dist/call-engine",
    bundle: false,
    platform: "node",
    format: "esm",
    sourcemap: true,
});
await build({
    absWorkingDir: root,
    entryPoints: ["web/app.jsx"],
    outfile: "dist/app.js",
    bundle: true,
    sourcemap: true,
    jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(path.join(root, "web/index.html"), path.join(root, "dist/index.html"));
console.log("Built audio call starter → dist/");
