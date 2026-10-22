// Explicit synthetic process-only capture test. Never opens mic or global tap.
// Optional --with-distractor plays a low-volume 997 Hz isolation control.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(directory, ".runtime");
mkdirSync(runtime, { recursive: true });
const binary = path.join(runtime, "test-tone");
const build = spawnSync("clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path.join(directory,"native/tap-tone.c"), "-framework", "CoreAudio", "-o", binary], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const children = [];
const result = { passed: false, isolation: process.argv.includes("--with-distractor"), capturedProcess: "owned synthetic tone only", timestamp: new Date().toISOString() };
function launch(command, args, options = {}) {
    const child = spawn(command,args,{ stdio: ["pipe","pipe","pipe","pipe"], ...options });
    children.push(child); child.errors = "";
    child.stderr.on("data",data => { child.errors += data.toString(); });
    return child;
}
function ready(child) {
    return new Promise((resolve,reject) => {
        let text = "";
        const timer = setTimeout(() => done(new Error(`Ready timeout: ${child.errors}`)),10000);
        function done(error,value) {
            clearTimeout(timer); child.stdout.off("data",ondata); child.off("error",onerror); child.off("exit",onexit);
            error ? reject(error) : resolve(value);
        }
        function onerror(error) { done(error); }
        function onexit(code,signal) { done(new Error(`Exited before ready: ${code}/${signal} ${text} ${child.errors}`)); }
        function ondata(data) {
            text += data.toString(); let end;
            while ((end = text.indexOf("\n")) >= 0) {
                const line = text.slice(0,end); text = text.slice(end + 1);
                try { const message = JSON.parse(line); if (message.type === "error") return done(new Error(JSON.stringify(message))); if (message.type === "ready") return done(null,message); }
                catch (error) { return done(error); }
            }
        }
        child.stdout.on("data",ondata); child.once("error",onerror); child.once("exit",onexit);
    });
}
function amplitude(values,frequency) {
    let re = 0, im = 0;
    for (let i = 0; i < values.length; ++i) {
        re += values[i] * Math.cos(2 * Math.PI * frequency * i / 48000);
        im += values[i] * Math.sin(2 * Math.PI * frequency * i / 48000);
    }
    return 2 * Math.hypot(re,im) / values.length;
}
try {
    const target = launch(binary,["440","0.05"]); result.target = await ready(target);
    let distractor;
    if (result.isolation) { distractor = launch(binary,["997","0.02"]); await ready(distractor); }
    const tap = launch(path.join(runtime,"process-tap"),["--pid",String(target.pid),"--capture-fd3"]);
    const blocks = []; let collecting = false, total = 0;
    tap.stdio[3].on("data",chunk => { if (collecting && total < 48000 * 2 * 3) { blocks.push(chunk); total += chunk.length; } });
    result.tap = await ready(tap);
    // START cannot run before the tap reports successful private capture startup.
    target.stdin.write("START\n"); if (distractor) distractor.stdin.write("START\n");
    await new Promise(resolve => setTimeout(resolve,300)); collecting = true;
    await new Promise(resolve => setTimeout(resolve,2200)); collecting = false;
    target.stdin.write("STOP\n"); if (distractor) distractor.stdin.write("STOP\n");
    assert.equal(tap.exitCode,null,"Tap exited while capturing");
    const bytes = Buffer.concat(blocks); const count = Math.min(Math.floor(bytes.length / 2),96000);
    assert.ok(count >= 72000,`Too few samples: ${count}`);
    const values = new Float64Array(count); let energy = 0;
    for (let i = 0; i < count; ++i) { values[i] = bytes.readInt16LE(i * 2) / 32768; energy += values[i] ** 2; }
    result.samples = count; result.rms = Math.sqrt(energy / count);
    result.amplitude440 = amplitude(values,440); result.amplitude997 = amplitude(values,997);
    assert.ok(result.rms > .01,`RMS too low: ${result.rms}`);
    assert.ok(result.amplitude440 > .015,`440 Hz target missing: ${result.amplitude440}`);
    assert.ok(result.amplitude997 < .002,`997 Hz leaked: ${result.amplitude997}`);
    assert.ok(result.amplitude440 > result.amplitude997 * 20,"Target/control ratio below 20");
    result.passed = true;
} catch (error) { result.error = error.stack; process.exitCode = 1; }
finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); },2000);
        child.once("exit",() => { clearTimeout(timer); resolve(); });
    })));
    writeFileSync(path.join(runtime,"process-tap-test.json"),JSON.stringify(result,null,2) + "\n");
    console.log(JSON.stringify(result,null,2));
}
