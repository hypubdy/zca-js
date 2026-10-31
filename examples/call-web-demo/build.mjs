import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(directory, "dist"), { recursive: true });
await build({
    absWorkingDir: directory,
    entryPoints: ["web/main.jsx", "web/simple.jsx"],
    bundle: true,
    outdir: "dist",
    minify: true,
    sourcemap: true,
    jsx: "automatic",
    // The call client lives at the repo root and declares React as a peer
    // dependency; resolve it from the demo's node_modules.
    nodePaths: [path.join(directory, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(path.join(directory, "web/index.html"), path.join(directory, "dist/index.html"));
await copyFile(path.join(directory, "web/simple.html"), path.join(directory, "dist/simple.html"));
await copyFile(path.join(directory, "../../docs/zalo-call-flow.html"), path.join(directory, "dist/call-flow.html"));
console.log("Built React demos → dist/");
