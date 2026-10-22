// Local, bounded IPC experiment. Never places calls or forwards credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const executableIndex = process.argv.indexOf("--executable");
const executable = (executableIndex >= 0 ? process.argv[executableIndex + 1] : process.env.ZALO_CALL_EXECUTABLE) || "/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall";
const initialize = process.argv.includes("--init") || process.env.ZALO_TRIAL_INIT === "1";
function readBundledMain() {
    if (process.env.ZALO_MAIN_SOURCE) return fs.readFileSync(process.env.ZALO_MAIN_SOURCE, "utf8");
    const archive = "/Applications/Zalo.app/Contents/Resources/app.asar";
    const fd = fs.openSync(archive, "r");
    try {
        const preamble = Buffer.alloc(16);
        fs.readSync(fd, preamble, 0, 16, 0);
        const header = Buffer.alloc(preamble.readUInt32LE(12));
        fs.readSync(fd, header, 0, header.length, 16);
        const entry = JSON.parse(header.toString()).files["main-dist"].files["main.js"];
        if (entry.unpacked) throw new Error("Expected packed main-dist/main.js");
        const bytes = Buffer.alloc(entry.size);
        fs.readSync(fd, bytes, 0, bytes.length, 8 + preamble.readUInt32LE(4) + Number(entry.offset));
        return bytes.toString("utf8");
    } finally { fs.closeSync(fd); }
}
const source = readBundledMain();
const match = source.match(/callV2TransportAesKey:\s*"([^"]+)"/);
if (!match) throw new Error("Cannot find bundled IPC transport key in supplied main source");
const key = Buffer.from(match[1], "base64");
const iv = Buffer.alloc(16);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zca-call-trial-"));
const recvPath = path.join(directory, "recv");
const sendPath = path.join(directory, "send");
const events = [];
const sockets = new Set();
let child;
let commandSocket;
let finished = false;
let requestedDevices = false;
let deviceSelectionState = "idle";
const log = (type, data = {}) => {
    const event = { elapsedMs: Date.now() - started, type, ...data };
    events.push(event);
    console.log(JSON.stringify(event));
    if (finished) fs.writeFileSync(path.join(directory, "events.json"), JSON.stringify({ executable, events }, null, 2));
};
const started = Date.now();
function decrypt(hex) {
    const cipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([cipher.update(Buffer.from(hex, "hex")), cipher.final()]).toString("utf8").replace(/\0/g, "");
}
function send(message) {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    const hex = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]).toString("hex");
    // macOS desktop sends <=4000-character chunks and waits for an ACK per chunk.
    if (hex.length > 4000) throw new Error("Trial only admits unfragmented command frames");
    commandSocket.write(hex + "$");
    log("sent", { message });
}
const recv = net.createServer(socket => {
    sockets.add(socket);
    log("connected", { channel: "native-to-host" });
    let pending = "";
    socket.on("data", data => {
        pending += data.toString();
        while (pending.includes("$")) {
            const end = pending.indexOf("$");
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!frame) continue;
            try {
                const message = JSON.parse(decrypt(frame));
                log("received", { message });
                if (message.command === "listDevice" && message.type === "response" &&
                    process.argv.includes("--virtual-devices") && deviceSelectionState === "idle") {
                    const input = message.data.otherAudInputDevice.find(device => device.guid === "MSLoopbackDriverDevice_UID");
                    const output = message.data.otherAudOutputDevice.find(device => device.guid === "MSLoopbackDriverDevice_UID");
                    if (input && output) {
                        deviceSelectionState = "updating";
                        send({ type: "update", command: "listDevice", data: {
                            autoAudioInput: false, autoAudioOutput: false,
                            defaultAudInputDevice: input, defaultAudOutputDevice: output,
                            defaultVidDevice: message.data.defaultVidDevice,
                        } });
                    } else log("virtual-device-unavailable");
                }
                if (message.command === "native-ready" && initialize) {
                    if (commandSocket) sendInit();
                    else setTimeout(() => commandSocket && sendInit(), 100);
                }
            } catch (error) { log("decode-error", { error: String(error), length: frame.length }); }
        }
    });
    socket.on("error", error => log("socket-error", { error: String(error) }));
});
function sendInit() {
    send({ type: "update", command: "init", data: {
        local: { id: "0", name: "Offline IPC trial", avatar: "" },
        clientVersion: 685, language: "en", osInfo: "darwin arm64",
        logPath: path.join(directory, "call.log"), zrtcLogPath: path.join(directory, "zrtc.log"),
        dumpPath: path.join(directory, "crash.dmp"),
    } });
}
const sender = net.createServer(socket => {
    sockets.add(socket);
    commandSocket = socket;
    log("connected", { channel: "host-to-native" });
    socket.on("data", data => {
        log("ack", { bytes: data.length });
        if (process.argv.includes("--devices") && !requestedDevices) {
            requestedDevices = true;
            send({ type: "request", command: "listDevice", data: null });
        } else if (deviceSelectionState === "updating") {
            deviceSelectionState = "queried";
            send({ type: "request", command: "listDevice", data: null });
        }
    });
    socket.on("error", error => log("socket-error", { error: String(error) }));
});
for (const server of [recv, sender]) server.on("error", error => {
    log("server-error", { error: String(error) });
    finish();
});
async function listen(server, socketPath) {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
}
function finish() {
    if (finished) return;
    finished = true;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    recv.close(); sender.close();
    fs.writeFileSync(path.join(directory, "events.json"), JSON.stringify({ executable, events }, null, 2));
    console.log(JSON.stringify({ type: "report", directory }));
    const killTimer = setTimeout(() => { if (child?.exitCode === null) child.kill("SIGKILL"); }, 1500);
    killTimer.unref();
}
await listen(recv, recvPath);
await listen(sender, sendPath);
log("launch", { executable, args: [recvPath, sendPath], init: initialize });
child = spawn(executable, [recvPath, sendPath], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", data => log("stdout", { text: data.toString().slice(0, 3000) }));
child.stderr.on("data", data => log("stderr", { text: data.toString().slice(0, 3000) }));
child.on("error", error => { log("launch-error", { error: String(error) }); finish(); });
child.on("exit", (code, signal) => { log("exit", { code, signal }); finish(); });
const timeout = setTimeout(finish, 10000);
timeout.unref();
process.once("SIGINT", finish);
process.once("SIGTERM", finish);
const fridaIndex = process.argv.indexOf("--frida-module");
if (fridaIndex >= 0) {
    try {
        const frida = await import(pathToFileURL(process.argv[fridaIndex + 1]).href);
        const session = await frida.attach(child.pid);
        const script = await session.createScript(`
            const module = Process.getModuleByName("ZaloCall");
            const names = ["RecordedDataIsAvailable", "NeedMorePlayData"];
            for (const name of names) {
                const matches = module.enumerateSymbols().filter(s => s.name.includes(name) && s.name.includes("AudioDevice"));
                for (const symbol of matches) {
                    let calls = 0;
                    Interceptor.attach(symbol.address, { onEnter() {
                        calls++;
                        if (calls === 1) send({ event: "callback-observed", name });
                    }});
                    send({ event: "hook-installed", name, symbol: symbol.name, address: symbol.address.toString() });
                }
            }
        `);
        script.message.connect(message => log("frida", { message }));
        await script.load();
        log("frida-attached", { pid: child.pid });
        child.once("exit", () => { session.detach().catch(() => {}); });
    } catch (error) { log("frida-error", { error: String(error) }); }
}
