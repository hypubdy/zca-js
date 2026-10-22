import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(directory, "dist"), { recursive: true });
await build({
    absWorkingDir: directory,
    entryPoints: ["web/main.jsx"],
    bundle: true,
    outdir: "dist",
    minify: true,
    sourcemap: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(path.join(directory, "web/index.html"), path.join(directory, "dist/index.html"));
console.log("Built React demo → dist/");
