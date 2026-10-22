// Opt-in experimental adapter. No login or call is attempted on server startup.
import { parseZrtcOutgoingPreflight } from "../../dist/call/negotiation.js";
import { safeCallError } from "./outgoing-diagnostics.mjs";
export class ZaloSession {
    constructor(notify, getHelper, isLive, { onControl } = {}) {
        this.notify = notify;
        this.getHelper = getHelper;
        this.isLive = isLive;
        this.onControl = onControl;
        this.state = "offline";
    }
    async login() {
        if (this.state === "connecting" || this.state === "online") return;
        const { Zalo } = await import("../../dist/index.js");
        this.state = "connecting";
        this.notify("zalo-state", { state: this.state });
        const generation = (this.generation = (this.generation || 0) + 1);
        const client = new Zalo({ checkUpdate: false, logging: false, selfListen: true });
        this.loginTask = client
            .loginQR({}, (event) => {
                if (event.actions?.abort) this.abort = event.actions.abort;
                if (generation !== this.generation) {
                    event.actions?.abort();
                    return;
                }
                if (event.type === 0) this.notify("zalo-qr", { image: event.data.image });
                if (event.type === 1 || event.type === 3) {
                    this.notify("zalo-state", {
                        state: "expired",
                        message: "QR hết hạn hoặc bị từ chối. Kết nối lại để lấy mã mới.",
                    });
                    event.actions?.abort();
                }
                if (event.type === 2) this.notify("zalo-state", { state: "scanned", name: event.data.display_name });
                // Never forward GotLoginInfo (cookies/IMEI) to browser or logs.
            })
            .then((api) => {
                if (generation !== this.generation) {
                    api.listener.stop();
                    return;
                }
                this.attachApi(api);
            })
            .catch(() => {
                if (generation === this.generation) {
                    this.state = "offline";
                    this.notify("zalo-state", {
                        state: "offline",
                        message: "Chưa đăng nhập được. Có thể QR hết hạn hoặc Zalo thay đổi luồng đăng nhập.",
                    });
                }
            });
    }
    async loginCredentials(credentials) {
        if (this.state === "connecting" || this.state === "online")
            throw new Error("A login/session is already active");
        const { Zalo } = await import("../../dist/index.js");
        this.state = "connecting";
        this.notify("zalo-state", { state: this.state });
        const client = new Zalo({
            checkUpdate: false,
            logging: false,
            selfListen: true,
            polyfill: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }),
        });
        try {
            const api = await client.login(credentials);
            this.attachApi(api);
            return { connected: true, voiceServiceAvailable: Boolean(api.zpwServiceMap.voice_call?.length) };
        } catch (error) {
            this.state = "offline";
            this.notify("zalo-state", {
                state: "offline",
                message: "Đăng nhập bằng credential thất bại; phiên có thể đã hết hiệu lực.",
            });
            return {
                connected: false,
                code: typeof error.code === "number" ? error.code : null,
                errorType: error.name,
            };
        }
    }
    attachApi(api) {
        this.api = api;
        this.state = "connecting";
        this.retryAttempt = 0;
        const ctx = api.getContext();
        api.custom("demoCallSignal", async ({ utils, props }) => {
            const domain = api.zpwServiceMap.voice_call?.[0];
            if (!domain) throw new Error("Voice call service is unavailable in this session");
            const encrypted = utils.encodeAES(JSON.stringify(props.params));
            if (!encrypted) throw new Error("Cannot encrypt call signal");
            return utils.resolve(
                await utils.request(utils.makeURL(`${domain}/api/voicecall/${props.action}`, { params: encrypted }), {
                    method: "GET",
                }),
            );
        });
        api.listener.on("call_control_batch", summary => {
            if (this.api === api) this.notify("zalo-control-batch", summary);
        });
        api.listener.on("call", (event) => {
            if (this.api !== api) return;
            this.onControl?.(event);
            if (["request", "group_request"].includes(event.act)) this.pendingControl = { event, at: Date.now(), forwarded: false };
            if (["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"].includes(event.act)) this.pendingControl = null;
            this.notify("incoming-control", { action: event.act });
            if (this.isLive() && this.getHelper()?.ready) {
                this.getHelper().send({ type: "control", data: event })
                    .then(() => { if (this.pendingControl?.event === event) this.pendingControl.forwarded = true; })
                    .catch((error) => this.notify("zalo-error", { message: error.message }));
            }
        });
        api.listener.on("error", () =>
            this.notify("zalo-error", { message: "Zalo listener gặp lỗi; kiểm tra phiên đăng nhập." }),
        );
        api.listener.on("connected", () => {
            if (this.api !== api) return;
            this.state = "online";
            clearTimeout(this.retryResetTimer);
            this.retryResetTimer = setTimeout(() => { this.retryAttempt = 0; }, 30000);
            this.notify("zalo-state", { state: this.state, name: "Tài khoản Zalo đã kết nối", uid: ctx.uid });
        });
        api.listener.on("disconnected", code => {
            if (this.api !== api) return;
            clearTimeout(this.retryResetTimer);
            this.state = "disconnected";
            this.pendingControl = null;
            const blocked = [1000, 3000, 3003].includes(code);
            this.notify("zalo-state", {
                state: this.state, code,
                message: code === 3000 ? "Phiên nhận cuộc gọi bị thay thế bởi kết nối Zalo khác. Bấm Kết nối lại sự kiện; tránh mở thêm Zalo Web cùng tài khoản."
                    : code === 3003 ? "Zalo đã ngắt phiên này; cần đăng nhập lại."
                    : `Kết nối sự kiện Zalo đã ngắt (mã ${code}); chưa thể nhận cuộc gọi.`,
            });
            if (!blocked && this.retryAttempt < 8) {
                clearTimeout(this.retryTimer);
                const delay = Math.min(30000, 1000 * 2 ** this.retryAttempt++);
                this.retryTimer = setTimeout(() => {
                    if (this.api === api && this.state === "disconnected") this.reconnect();
                }, delay);
            }
        });
        api.listener.start();
    }
    reconnect() {
        if (!this.api) throw new Error("Đăng nhập tài khoản trước khi kết nối lại");
        if (this.state === "online" || this.state === "connecting") return;
        clearTimeout(this.retryTimer);
        this.state = "connecting";
        this.notify("zalo-state", { state: this.state, message: "Đang kết nối lại luồng sự kiện Zalo…" });
        try { this.api.listener.start(); }
        catch {
            this.state = "disconnected";
            this.notify("zalo-state", { state: this.state, message: "Chưa nối lại được; hãy ngắt tài khoản và đăng nhập lại." });
        }
    }
    async flushPending() {
        const pending = this.pendingControl;
        if (!pending || pending.forwarded || Date.now() - pending.at > 60000) return false;
        if (!this.isLive() || !this.getHelper()?.ready) throw new Error("Prepare the audio route before accepting");
        await this.getHelper().send({ type: "control", data: pending.event });
        if (this.pendingControl === pending) pending.forwarded = true;
        this.notify("incoming-forwarded", { action: pending.event.act });
        return true;
    }
    local() {
        if (!this.api) return { id: "0", name: "Web audio demo", avatar: "" };
        return { id: String(this.api.getContext().uid), name: "Web call demo", avatar: "" };
    }
    async listFriends() {
        if (!this.api || this.state !== "online") throw new Error("Kết nối tài khoản Zalo trước khi tải bạn bè");
        const users = await this.api.getAllFriends(200, 1);
        if (!Array.isArray(users)) throw new Error("Danh sách bạn bè trả về không hợp lệ");
        // Never send phone numbers, session keys, or the full profile to the browser.
        return users.map(user => ({
            id: String(user?.userId ?? ""),
            name: String(user?.displayName || user?.zaloName || user?.username || user?.userId || ""),
        })).filter(user => /^\d+$/.test(user.id) && user.name).slice(0, 200);
    }
    async requestOutgoingCall(calleeId, callId = String(Date.now() & 0x7fffffff), onPreflight) {
        if (!this.api || this.state !== "online") throw new Error("Kết nối tài khoản Zalo trước khi thử gọi");
        if (typeof calleeId !== "string" || !/^\d+$/.test(calleeId)) throw new Error("Chọn một người bạn hợp lệ");
        if (!/^\d+$/.test(String(callId))) throw new Error("Call ID không hợp lệ");
        this.notify("outgoing-call-stage", { flow: "preflight", stage: "requestcall-start" });
        let response;
        try {
            response = await this.api.voiceCall.requestCall({ calleeId, callId: String(callId), typeRequest: 1, codec: "[]" });
        } catch (error) {
            this.notify("outgoing-call-error", { flow: "preflight", stage: "requestcall", ...safeCallError(error) });
            throw error;
        }
        // Keep raw session, SRTP config/key, and relay IPs in backend memory only.
        // The preflight alone is not the call invite; `/request` still requires
        // caller relay/media negotiation and is intentionally not sent here.
        let preflight;
        try {
            preflight = parseZrtcOutgoingPreflight(response);
            if (preflight.callId !== Number(callId)) throw new Error("401 response call ID không khớp requestcall");
            if (preflight.status !== 0) throw new Error(`Zalo từ chối preflight (status ${preflight.status})`);
        } catch (error) {
            this.notify("outgoing-call-error", { flow: "preflight", stage: "parse-or-validate", ...safeCallError(error) });
            throw error;
        }
        this.notify("outgoing-call-stage", { flow: "preflight", stage: "response-parsed",
            status: preflight.status, relayCandidates: preflight.servers.length,
            zrtcConfigPresent: Object.keys(preflight.zrtcConfig).length > 0 });
        let relay = null;
        if (typeof onPreflight === "function") {
            this.notify("outgoing-call-stage", { flow: "relay", stage: "registration-start",
                relayCandidates: preflight.servers.length });
            try { relay = await onPreflight(preflight); }
            catch (error) {
                this.notify("outgoing-call-error", { flow: "relay", stage: "registration", ...safeCallError(error) });
                throw error;
            }
        }
        const configKeys = Object.keys(preflight.zrtcConfig).filter(key =>
            ["srtpMode", "srtpRTCP", "packetMode", "srtpKey"].includes(key));
        const summary = { callId: String(callId), status: preflight.status,
            relayCandidates: preflight.servers.length, zrtcConfigPresent: Object.keys(preflight.zrtcConfig).length > 0,
            configKeys, callerRelayRegistered: relay?.registered === true };
        this.notify("zalo-outgoing-preflight", summary);
        this.notify("outgoing-call-stage", { flow: "relay", stage: relay?.registered ? "caller-relay-ready" : "preflight-only",
            relayCandidates: preflight.servers.length, callerRelayRegistered: relay?.registered === true });
        return { stage: relay?.registered ? "caller-relay-registered" : "preflight-parsed", ...summary,
            ringing: false, mediaReady: false, next: "start-browser-mic-then-send-request" };
    }
    async answerIndependent(payload) {
        if (!this.api || this.state !== "online") throw new Error("Kết nối tài khoản Zalo trước khi answer");
        const result = await this.api.voiceCall.answer(payload);
        // The encrypted API response is intentionally not forwarded or logged.
        this.notify("zalo-signal", { command: 402, action: "answer", success: true });
        return { responseReceived: true, responseAccepted: true, peerConfirmed: false,
            responseCode: result?.error_code ?? result?.code ?? null };
    }
    async endCall(uidTo, callId) {
        if (!this.api || this.state !== "online") throw new Error("Zalo chưa kết nối; chỉ có thể dừng audio cục bộ");
        if (typeof uidTo !== "string" || !uidTo || !/^\d+$/.test(String(callId)))
            throw new Error("Thiếu callerId hoặc callId của cuộc gọi đang hoạt động");
        const result = await this.api.voiceCall.end(uidTo, String(callId));
        this.notify("zalo-signal", { command: 409, action: "endcall", success: true });
        return { signalSent: true, responseCode: result?.error_code ?? result?.code ?? null };
    }
    async cancelOutgoingCall(callerId, callId, callType = 1) {
        if (!this.api || this.state !== "online") throw new Error("Zalo chưa kết nối; chỉ có thể đóng relay cục bộ");
        if (typeof callerId !== "string" || !/^\d+$/.test(callerId) || !/^\d+$/.test(String(callId)))
            throw new Error("Thiếu calleeId hoặc callId của outgoing call");
        const result = await this.api.voiceCall.cancel(callerId, String(callId), callType);
        this.notify("zalo-signal", { command: 405, action: "cancel", success: true });
        return { signalSent: true, responseCode: result?.error_code ?? result?.code ?? null };
    }
    async requestOutgoingMedia(payload) {
        if (!this.api || this.state !== "online") throw new Error("Kết nối tài khoản Zalo trước khi gửi lời mời");
        this.notify("outgoing-call-stage", { flow: "invite", stage: "request-start" });
        let result;
        try { result = await this.api.voiceCall.request(payload); }
        catch (error) {
            this.notify("outgoing-call-error", { flow: "invite", stage: "request", ...safeCallError(error) });
            throw error;
        }
        this.notify("zalo-signal", { command: 416, action: "request", success: true });
        this.notify("outgoing-call-stage", { flow: "invite", stage: "request-accepted" });
        return { requestAccepted: true, responseCode: result?.error_code ?? result?.code ?? null };
    }
    async acknowledgeOutgoingAnswer(calleeId, callId) {
        if (!this.api || this.state !== "online") throw new Error("Zalo chưa kết nối để ACK answer");
        const result = await this.api.voiceCall.answerAck(calleeId, String(callId));
        this.notify("zalo-signal", { command: 408, action: "answerack", success: true });
        return { responseCode: result?.error_code ?? result?.code ?? null };
    }
    async signal(command, data) {
        if (!this.api || !this.getHelper()?.ready || (![405, 406, 409].includes(command) && !this.isLive())) throw new Error("No active Zalo media session");
        const imei = this.api.getContext().imei;
        const mappings = {
            401: [
                "requestcall",
                {
                    calleeId: data.calleeId,
                    callId: data.callId,
                    codec: data.codec ?? "[]",
                    typeRequest: data.type,
                    imei,
                },
            ],
            416: [
                "request",
                {
                    calleeId: data.calleeId,
                    rtcpAddress: data.rtcpAddress,
                    rtpAddress: data.rtpAddress,
                    codec: data.codec,
                    session: data.session,
                    callId: data.callId,
                    imei,
                    ...(data.extendData ? { extendData: data.extendData, subCommand: 3 } : {}),
                },
            ],
            407: ["ringring", { callerId: data.callerId, callId: data.callId, status: 0, imei }],
            402: [
                "answer",
                {
                    callerId: data.callerId,
                    callId: data.callId,
                    status: data.status,
                    codec: data.codec || "",
                    rtcpAddress: data.rtcpAddress,
                    rtpAddress: data.rtpAddress,
                    session_id: data.session,
                    ...(data.extendData ? { extendData: data.extendData, subCommand: 3 } : {}),
                },
            ],
            408: ["answerack", { calleeId: data.calleeId, callId: data.callId, status: 0, imei }],
            405: ["cancel", { callerId: data.toId, callId: data.callId, callType: data.callType, status: 0, imei }],
            409: ["endcall", { uidTo: data.toId, callId: data.callId, status: 3, imei }],
            406: [
                "logendcall",
                {
                    call_id: data.callId,
                    partner_id: data.partnerId,
                    status: data.status,
                    logdata: data.data,
                    duration: data.duration,
                    role: data.role,
                    imei,
                },
            ],
        };
        const mapping = mappings[command];
        if (!mapping) throw new Error(`Unsupported native signal ${command}`);
        const result = await this.api.demoCallSignal({ action: mapping[0], params: mapping[1] });
        await this.getHelper().send({ type: "recvSignal", command, data: result });
        this.notify("zalo-signal", { command, action: mapping[0], success: true });
    }
    logout() {
        this.generation = (this.generation || 0) + 1;
        try {
            this.abort?.();
        } catch {
            /* QR might already be completed. */
        }
        this.abort = null;
        clearTimeout(this.retryTimer);
        clearTimeout(this.retryResetTimer);
        const api = this.api;
        this.api = null;
        api?.listener.stop();
        this.pendingControl = null;
        this.state = "offline";
        this.notify("zalo-state", { state: "offline" });
    }
}
