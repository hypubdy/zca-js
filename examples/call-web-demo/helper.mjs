import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export function readIpcKey(archive = "/Applications/Zalo.app/Contents/Resources/app.asar") {
    const fd = fs.openSync(archive, "r");
    try {
        const preamble = Buffer.alloc(16);
        fs.readSync(fd, preamble, 0, 16, 0);
        const headerSize = preamble.readUInt32LE(12);
        if (headerSize > 32 * 1024 * 1024) throw new Error("ASAR header too large");
        const header = Buffer.alloc(headerSize);
        fs.readSync(fd, header, 0, header.length, 16);
        const entry = JSON.parse(header.toString()).files["main-dist"].files["main.js"];
        const bytes = Buffer.alloc(entry.size);
        fs.readSync(fd, bytes, 0, bytes.length, 8 + preamble.readUInt32LE(4) + Number(entry.offset));
        const match = bytes.toString().match(/callV2TransportAesKey:\s*"([^"]+)"/);
        if (!match) throw new Error("Unsupported Zalo version: IPC transport key not found");
        return Buffer.from(match[1], "base64");
    } finally {
        fs.closeSync(fd);
    }
}

export class NativeHelper extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.sockets = new Set();
        this.fragments = new Map();
        this.ready = false;
        this.closed = false;
        this.waiters = [];
    }
    async start(local = { id: "0", name: "Web audio demo", avatar: "" }) {
        if (this.starting) return this.starting;
        this.starting = this._start(local);
        return this.starting;
    }
    async _start(local) {
        this.key = readIpcKey();
        this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "zca-web-call-"));
        const recvPath = path.join(this.directory, "rx"),
            sendPath = path.join(this.directory, "tx");
        this.recv = net.createServer((socket) => {
            this.sockets.add(socket);
            let pending = "";
            socket.on("error", (error) => this.emit("fault", error.message));
            socket.on("data", (chunk) => {
                pending += chunk.toString();
                if (pending.length > 4 * 1024 * 1024) return socket.destroy();
                while (pending.includes("$")) {
                    const end = pending.indexOf("$");
                    const frame = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    if (frame) this.receive(frame);
                }
            });
        });
        this.sender = net.createServer((socket) => {
            this.sockets.add(socket);
            this.socket = socket;
            socket.on("error", (error) => this.emit("fault", error.message));
            socket.on("data", () => {
                if (this.inflight) {
                    clearTimeout(this.ackTimer);
                    this.inflight.resolve();
                    this.inflight = null;
                    this.flush();
                }
            });
            this.flush();
        });
        for (const server of [this.recv, this.sender]) server.on("error", (error) => this.emit("fault", error.message));
        await Promise.all(
            [
                [this.recv, recvPath],
                [this.sender, sendPath],
            ].map(
                ([server, endpoint]) =>
                    new Promise((resolve, reject) => {
                        server.once("error", reject);
                        server.listen(endpoint, resolve);
                    }),
            ),
        );
        const ready = this.waitFor((message) => message.command === "native-ready", 10000);
        this.child = spawn(
            process.env.ZALO_CALL_EXECUTABLE ||
                "/Applications/Zalo.app/Contents/ZaloHelper.app/Contents/MacOS/ZaloCall",
            [recvPath, sendPath],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        this.child.on("error", (error) => {
            this.emit("fault", error.message);
            this.stop();
        });
        this.child.on("exit", () => {
            this.ready = false;
            this.emit("stopped");
            this.stop();
        });
        this.child.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString().slice(0, 500)));
        this.child.stdout.resume();
        try {
            await ready;
            this.ready = true;
            await this.init(local);
            return await this.devices();
        } catch (error) {
            this.stop();
            throw error;
        }
    }
    init(local) {
        return this.send({
            type: "update",
            command: "init",
            data: {
                local,
                mainWindowId: local.id,
                clientVersion: 685,
                language: "vi",
                osInfo: "darwin arm64",
                logPath: path.join(this.directory, "call.log"),
                zrtcLogPath: path.join(this.directory, "zrtc.log"),
                dumpPath: path.join(this.directory, "crash.dmp"),
                enablePreviewDeviceOutgoing: false,
                enablePreviewDeviceIncall: false,
            },
        });
    }
    receive(frame) {
        try {
            if (frame.includes("#")) {
                const [chunk, id, countText, indexText] = frame.split("#");
                const count = Number(countText),
                    index = Number(indexText);
                if (!Number.isInteger(count) || count < 1 || count > 1024 || index < 0 || index >= count)
                    throw new Error("Invalid IPC fragment");
                const parts = this.fragments.get(id) || new Map();
                parts.set(index, chunk);
                this.fragments.set(id, parts);
                if (parts.size !== count) return;
                frame = Array.from({ length: count }, (_, i) => parts.get(i)).join("");
                this.fragments.delete(id);
            }
            const cipher = crypto.createDecipheriv("aes-128-cbc", this.key, Buffer.alloc(16));
            const text = Buffer.concat([cipher.update(Buffer.from(frame, "hex")), cipher.final()])
                .toString()
                .replace(/\0/g, "");
            const message = JSON.parse(text);
            for (const waiter of [...this.waiters]) if (waiter.predicate(message)) waiter.resolve(message);
            this.emit("message", message);
        } catch (error) {
            this.emit("fault", `IPC: ${error.message}`);
        }
    }
    waitFor(predicate, ms = 5000) {
        return new Promise((resolve, reject) => {
            const waiter = {
                predicate,
                resolve: (message) => {
                    done();
                    resolve(message);
                },
                reject: (error) => {
                    done();
                    reject(error);
                },
            };
            const done = () => {
                clearTimeout(timer);
                this.waiters = this.waiters.filter((item) => item !== waiter);
            };
            const timer = setTimeout(() => waiter.reject(new Error("Native response timeout")), ms);
            this.waiters.push(waiter);
        });
    }
    async devices() {
        const response = this.waitFor((message) => message.type === "response" && message.command === "listDevice");
        // Attach a rejection handler immediately while the send awaits its ACK.
        response.catch(() => {});
        await this.send({ type: "request", command: "listDevice", data: null });
        const result = (await response).data;
        this.deviceList = result;
        return result;
    }
    async selectDevices(inputUid, outputUid) {
        const devices = await this.devices();
        const input = devices.otherAudInputDevice.find((device) => device.guid === inputUid);
        const output = devices.otherAudOutputDevice.find((device) => device.guid === outputUid);
        if (!input || !output) throw new Error("Selected device not visible to ZaloCall");
        await this.send({
            type: "update",
            command: "listDevice",
            data: {
                autoAudioInput: false,
                autoAudioOutput: false,
                defaultAudInputDevice: input,
                defaultAudOutputDevice: output,
                defaultVidDevice: devices.defaultVidDevice,
            },
        });
        const selected = await this.devices();
        if (selected.defaultAudInputDevice.guid !== inputUid || selected.defaultAudOutputDevice.guid !== outputUid)
            throw new Error("Native device selection did not persist");
        return selected;
    }
    async send(message) {
        if (this.closed) throw new Error("Helper is stopped");
        const cipher = crypto.createCipheriv("aes-128-cbc", this.key, Buffer.alloc(16));
        const text = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]).toString("hex");
        const count = Math.ceil(text.length / 4000),
            id = Date.now();
        for (let index = 0; index < count; index++) {
            const chunk = text.slice(index * 4000, (index + 1) * 4000);
            const frame = count === 1 ? chunk + "$" : `${chunk}#${id}#${count}#${index}#$`;
            await new Promise((resolve, reject) => {
                this.queue.push({ frame, resolve, reject });
                this.flush();
            });
        }
    }
    flush() {
        if (!this.socket || this.inflight || !this.queue.length || this.closed) return;
        this.inflight = this.queue.shift();
        this.ackTimer = setTimeout(() => {
            this.inflight?.reject(new Error("Native ACK timeout"));
            this.inflight = null;
            this.stop();
        }, 5000);
        this.socket.write(this.inflight.frame);
    }
    stop() {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        clearTimeout(this.ackTimer);
        for (const item of [this.inflight, ...this.queue]) item?.reject(new Error("Helper stopped"));
        for (const waiter of [...this.waiters]) waiter.reject(new Error("Helper stopped"));
        this.queue = [];
        this.inflight = null;
        for (const socket of this.sockets) socket.destroy();
        this.recv?.close();
        this.sender?.close();
        if (this.child?.exitCode === null && this.child?.signalCode === null) {
            const child = this.child;
            child.kill("SIGTERM");
            const timer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 1000);
            timer.unref();
        }
    }
}
