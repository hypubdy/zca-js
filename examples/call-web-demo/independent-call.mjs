import { isIP } from "node:net";
import { writeFileSync } from "node:fs";
import { buildZrtcAcceptedAnswer, buildZrtcVideoCapabilities, parseZrtcIncomingOffer, parseZrtcOutgoingAnswer } from "../../dist/call/negotiation.js";
import { probeZrtpRelay, ZrtpRelaySession } from "../../dist/call/relayRegistration.js";
import { buildCompoundRtcpPli, buildCompoundRtcpReport, parseCompoundRtcp, parseRtpPacket, RtpAudioSender, RtpReceptionStats, SrtcpContext, SrtpRtpContext, VideoRtpBridge, selectZrtcSrtpKey } from "../../dist/call/index.js";
import { selectNativeOpusCodec, ZrtcOpusGateway } from "./opus-gateway.mjs";
import { randomInt } from "node:crypto";
import { safeCallError } from "./outgoing-diagnostics.mjs";

const terminal = new Set(["cancel", "endcall", "end_call", "end", "group_cancel", "group_endcall", "group_end_call"]);
const diagnosticCapabilities = new Set(["srtpMode", "srtcp", "srtpRTCP", "srtpNoSeq", "noSeq", "packetMode",
    "platform", "protocol", "gccMode", "sP2P", "tpType", "spTcp", "gccAudio", "gccSVLR", "gccEarlyCall", "callType", "newZrtc"]);
function safeCapabilities(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { present: value !== undefined, type: value === null ? "null" : typeof value };
    const fields = {};
    for (const key of diagnosticCapabilities) {
        if (Object.hasOwn(value, key)) {
            const item = value[key];
            if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) fields[key] = item;
            else fields[key] = { type: Array.isArray(item) ? "array" : typeof item };
        }
    }
    const video = value.video;
    if (video && typeof video === "object" && !Array.isArray(video)) {
        const videoFields = {};
        for (const key of ["codec", "payload", "profile", "width", "height", "fps"]) {
            if (!Object.hasOwn(video, key)) continue;
            const item = video[key];
            if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) videoFields[key] = item;
            else if (typeof item === "string" && /^[A-Za-z0-9._/-]{1,64}$/.test(item)) videoFields[key] = item;
            else videoFields[key] = { type: Array.isArray(item) ? "array" : typeof item };
        }
        fields.video = videoFields;
    }
    return { present: true, fields };
}
function safeEndpoint(value) {
    if (typeof value !== "string") return { present: value !== undefined, valid: false };
    const split = value.lastIndexOf(":");
    if (split < 0) return { present: true, valid: false };
    const host = value.slice(0, split).replace(/^\[|\]$/g, "");
    const port = Number(value.slice(split + 1));
    const family = isIP(host);
    return { present: true, valid: Boolean(family && Number.isInteger(port) && port >= 1 && port <= 65535),
        ...(family ? { family: family === 4 ? "ipv4" : "ipv6" } : {}),
        ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}) };
}
function safeOfferDiagnostics(offer) {
    let extendData;
    try { extendData = offer.extendData === undefined ? undefined : JSON.parse(offer.extendData); }
    catch { extendData = null; }
    return {
        callIdPresent: Number.isInteger(offer.callId),
        sessionIdLength: offer.sessionId.length,
        platform: offer.platform ?? null,
        protocol: offer.protocol ?? null,
        rtp: safeEndpoint(offer.rtpAddress),
        rtcp: safeEndpoint(offer.rtcpAddress),
        codecs: offer.codecs.map(({ name, payload, frmPtime, dynamicFptime }) => ({ name, payload, frmPtime, dynamicFptime })),
        videoRequested: offer.videoRequested === true,
        callType: offer.callType ?? null,
        videoEnable: offer.videoEnable ?? null,
        videoCodecId: offer.videoCodecId ?? null,
        videoCodecIds: offer.videoCodecIds ?? [],
        videoCodecs: offer.videoCodecs ?? [],
        extendData: safeCapabilities(extendData),
        zrtcConfig: safeCapabilities(offer.zrtcConfig),
    };
}
/** Independent research adapter. No helper, IPC, CoreAudio or Zalo native code. */
export class IndependentCall {
    constructor(notify) { this.notify = notify; this.openRelay = (...args) => ZrtpRelaySession.open(...args); }
    activeCall() { return this.pending?.offer || (this.outgoing ? { uidN: this.outgoing.calleeId,
        callId: this.outgoing.callId, callType: this.outgoing.callType ?? 1, direction: "outgoing", stage: this.outgoing.stage } : null); }
    status() {
        return { engine: "independent", nativeEngine: false, mediaReady: false, browserBridgeAvailable: Boolean((this.relay?.registered || this.outgoing?.relay?.registered) && this.opus && this.srtpSend &&
            (this.srtcpEnabled === false || (this.srtcpSend && this.srtcpReceive))), relayConnectAvailable: true,
            answerTrialAvailable: Boolean(this.pending && this.relay?.registered && this.opus && this.srtpSend &&
                this.srtpProfile === 1 && this.srtcpEnabled === false &&
                this.pending.offer.videoRequested !== true &&
                this.pending.offer.rtpAddress === this.pending.offer.rtcpAddress && !this.answerSignalSent),
            answerSignalSent: Boolean(this.answerSignalSent), confirmed: this.confirmed === true,
            answerInFlight: Boolean(this.answerInFlight),
            relayConnecting: Boolean(this.relayTask),
            relayRegistered: Boolean(this.relay?.registered),
            outgoingRelayRegistered: Boolean(this.outgoing?.relay?.registered),
            outgoingCallId: this.outgoing?.callId ?? null,
            outgoingStage: this.outgoing?.stage ?? null,
            codecReady: Boolean(this.opus),
            srtpRtpReady: Boolean(this.srtpSend),
            srtcpReady: Boolean(this.srtcpSend && this.srtcpReceive) || this.srtcpEnabled === false,
            offerParsed: Boolean(this.pending),
            offerDiagnostics: this.offerDiagnostics || null,
            codecs: this.pending?.offer.codecs.map(item => ({ name: item.name, payload: item.payload })) || [],
            mediaDiagnostics: { ...(this.mediaDiagnostics || {}) },
            lastMediaDiagnostics: { ...(this.lastMediaDiagnostics || {}) },
            lastVideoDiagnostics: { ...(this.lastVideoDiagnostics || {}) },
            videoRelayRtpPackets: this.videoRelayRtpPackets || 0,
            videoRelayRtcpPackets: this.videoRelayRtcpPackets || 0,
            videoPliSent: this.videoPliSent || 0,
            videoRtcpReportsSent: this.videoRtcpReportsSent || 0,
            videoCameraStateSent: this.videoCameraStateSent || 0,
            videoCameraOnSignalsSent: this.videoCameraOnSignalsSent || 0,
            videoCallTrialAvailable: Boolean(this.pending?.offer.videoRequested === true && this.videoBridge && !this.answerSignalSent),
            videoBridgeReady: Boolean(this.videoBridge),
            videoCodec: this.videoPayloadType ?? null,
            videoSentPayloadType: this.videoBridge?.sentPayloadType ?? this.videoSentPayloadType ?? null,
            videoPacketFormat: this.videoBridge?.packetFormatName ?? this.videoPacketFormatOverride ?? null,
            videoExtensions: this.videoBridge?.extensionsEnabled ?? this.videoExtensionsOverride ?? null,
            incompleteAccessUnits: this.videoBridge?.incompleteAccessUnits ?? 0,
            answerPacketMode: this.outgoingAnswerPacketMode ?? null,
            videoPacketMode: this.pending?.offer?.zrtcConfig?.packetMode ?? this.outgoing?.preflight?.zrtcConfig?.packetMode ?? null,
            videoPacketsSent: this.videoBridge?.sentPackets ?? 0,
            videoFramesSent: this.videoBridge?.sentFrames ?? 0,
            videoKeyFramesSent: this.videoBridge?.sentKeyFrames ?? 0,
            videoPacketsReceived: this.videoBridge?.receivedPackets ?? 0,
            videoFramesReceived: this.videoBridge?.receivedFrames ?? 0,
            videoKeyFramesReceived: this.videoBridge?.receivedKeyFrames ?? 0,
            videoPacketsRejected: this.videoBridge?.rejectedPackets ?? 0,
            videoFrameBytes: { sent: this.videoBridge?.sentFrameBytes ?? 0,
                received: this.videoBridge?.receivedFrameBytes ?? 0,
                min: this.videoBridge?.receivedFrameMinBytes ?? 0,
                max: this.videoBridge?.receivedFrameMaxBytes ?? 0 },
            videoAuxiliaryPackets: this.videoBridge?.auxiliaryPackets ?? 0,
            videoRejectReasons: { ...(this.videoBridge?.rejectionReasons || {}) },
            videoObservedSsrcs: { ...(this.videoBridge?.observedSsrcs || {}) },
            videoObservedPayloadTypes: { ...(this.videoBridge?.observedPayloadTypes || {}) },
            videoObservedPayloadFirstBytes: { ...(this.videoBridge?.observedPayloadFirstBytes || {}) },
            videoObservedExtensionProfiles: { ...(this.videoBridge?.observedExtensionProfiles || {}) },
            videoObservedExtensionElements: { ...(this.videoBridge?.observedExtensionElements || {}) },
            videoObservedExtensionSamples: { ...(this.videoBridge?.observedExtensionSamples || {}) },
            videoSentH264NalTypes: { ...(this.videoBridge?.sentH264NalTypes || {}) },
            videoSentH264NalSamples: { ...(this.videoBridge?.sentH264NalSamples || {}) },
            videoReceivedH264NalTypes: { ...(this.videoBridge?.receivedH264NalTypes || {}) },
            videoReceivedH264NalSamples: { ...(this.videoBridge?.receivedH264NalSamples || {}) },
            videoLastRejection: this.videoBridge?.lastRejection || null,
            limitation: this.pending?.offer.videoRequested === true
                ? (this.videoBridge ? "Video bridge H264/SRTP đã sẵn sàng; answer chỉ xác nhận sau ACK của peer." : "Offer video chưa có H264 payload dạng name/payload để mở bridge.")
                : "Answer trial cần người dùng bấm sau khi chuẩn bị audio; media chỉ confirmed sau answer ACK của peer." };
    }
    observe(event) {
        if (terminal.has(event.act)) { this.pending = null; this.answerSignalSent = false; this.confirmed = false; this.clearRelay(); this.outgoing = null; }
        else if (event.act === "request") {
            this.confirmed = false;
            this.answerSignalSent = false;
            this.clearRelay();
            this.pending = null;
            this.outgoing = null;
            try {
                const offer = parseZrtcIncomingOffer(event.data);
                this.pending = { offer, at: Date.now() };
                this.offerDiagnostics = safeOfferDiagnostics(offer);
                this.notify("independent-offer", this.offerDiagnostics);
            }
            catch (error) { this.notify("independent-error", { message: `Chưa đọc được offer: ${error.message}` }); }
        }
        else if (event.act === "answer" && this.outgoing) {
            try {
                const answer = parseZrtcOutgoingAnswer(event.data);
                if (answer.callId === this.outgoing.callId) {
                    this.outgoing.answer = answer;
                    this.outgoing.stage = answer.status === 0 ? "answer-received" : "answer-rejected";
                    let extendData;
                    try { extendData = answer.extendData === undefined ? undefined : JSON.parse(answer.extendData); }
                    catch { extendData = null; }
                    this.notify("independent-outgoing-answer", { callId: answer.callId, status: answer.status,
                        platform: answer.platform,
                        codecs: answer.codecs.map(({ name, payload, frmPtime, dynamicFptime }) => ({ name, payload, frmPtime, dynamicFptime })),
                        extendData: safeCapabilities(extendData), confirmed: false });
                }
            } catch (error) { this.notify("independent-error", { message: `Chưa đọc được answer gọi đi: ${error.message}` }); }
        }
        else if (["ringring", "ringing"].includes(event.act) && this.outgoing) {
            const data = event.data && typeof event.data === "object" ? event.data : {};
            const callId = data.callId ?? data.call_id ?? data.id;
            if (callId !== undefined && String(callId) === String(this.outgoing.callId)) {
                this.outgoing.stage = "remote-ringing";
                this.notify("independent-outgoing-ringing", { callId: this.outgoing.callId });
            }
        }
        else if (["answerack", "answer_ack", "answer-ack"].includes(event.act) &&
            (this.answerSignalSent || this.answerInFlight) && this.pending) {
            const data = event.data && typeof event.data === "object" ? event.data : {};
            const callId = data.callId ?? data.call_id ?? data.id;
            if (callId !== undefined && String(callId) === String(this.pending.offer.callId)) {
                this.confirmed = true;
                this.videoBridge?.setConfirmed(true);
                if (this.videoBridge && this.relay?.registered) {
                    this.relay.sendLocalCameraState(true, 0);
                    this.videoCameraOnSignalsSent = (this.videoCameraOnSignalsSent || 0) + 1;
                    this.relay.sendVideoSuspend(false, 0);
                    this.videoCameraStateSent = (this.videoCameraStateSent || 0) + 1;
                    this.notify("independent-video-camera-state", { enabled: true, direction: "incoming",
                        localCameraSignalsSent: this.videoCameraOnSignalsSent, suspendSignalsSent: this.videoCameraStateSent });
                }
                this.notify("independent-confirmed", { confirmed: true });
            }
        }
        this.notify("independent-state", this.status());
    }
    clear(sendEnd = false) { this.pending = null; this.clearRelay(sendEnd); this.outgoing = null; this.notify("independent-state", this.status()); }
    clearRelay(sendEnd = true) {
        if (this.videoBridge) {
            this.lastVideoDiagnostics = {
                direction: this.videoDirection || "unknown",
                packetMode: this.videoPacketMode ?? null,
                sentPayloadType: this.videoSentPayloadType ?? null,
                receivePayloadType: this.videoBridge?.receivePayloadType ?? null,
                relayRtpPackets: this.videoRelayRtpPackets || 0,
                relayRtcpPackets: this.videoRelayRtcpPackets || 0,
                pliSent: this.videoPliSent || 0,
                rtcpReportsSent: this.videoRtcpReportsSent || 0,
                cameraOnSignalsSent: this.videoCameraOnSignalsSent || 0,
                suspendSignalsSent: this.videoCameraStateSent || 0,
                rtpPacketsSent: this.videoBridge.sentPackets,
                framesSent: this.videoBridge.sentFrames,
                keyFramesSent: this.videoBridge.sentKeyFrames,
                rtpPacketsAccepted: this.videoBridge.receivedPackets,
                framesReceived: this.videoBridge.receivedFrames,
                keyFramesReceived: this.videoBridge.receivedKeyFrames,
                rtpPacketsRejected: this.videoBridge.rejectedPackets,
                auxiliaryPackets: this.videoBridge.auxiliaryPackets,
                frameBytes: { sent: this.videoBridge.sentFrameBytes, received: this.videoBridge.receivedFrameBytes,
                    min: this.videoBridge.receivedFrameMinBytes, max: this.videoBridge.receivedFrameMaxBytes },
                rejectReasons: { ...this.videoBridge.rejectionReasons },
                payloadTypes: { ...this.videoBridge.observedPayloadTypes },
                payloadFirstBytes: { ...this.videoBridge.observedPayloadFirstBytes },
                extensionProfiles: { ...this.videoBridge.observedExtensionProfiles },
                extensionElements: { ...this.videoBridge.observedExtensionElements },
                extensionSamples: { ...this.videoBridge.observedExtensionSamples },
                sentH264NalTypes: { ...this.videoBridge.sentH264NalTypes },
                sentH264NalSamples: { ...this.videoBridge.sentH264NalSamples },
                receivedH264NalTypes: { ...this.videoBridge.receivedH264NalTypes },
                receivedH264NalSamples: { ...this.videoBridge.receivedH264NalSamples },
                ssrcs: { ...this.videoBridge.observedSsrcs },
                endedAt: Date.now(),
            };
        }
        this.videoBridge?.close();
        this.videoBridge = undefined;
        this.videoPayloadType = undefined;
        this.videoPacketMode = undefined;
        this.videoDirection = undefined;
        this.videoRelayRtpPackets = 0;
        this.videoRelayRtcpPackets = 0;
        this.videoPliSent = 0;
        this.videoRtcpReportsSent = 0;
        this.videoCameraStateSent = 0;
        this.videoCameraOnSignalsSent = 0;
        this.videoSrtcpSend?.destroy(); this.videoSrtcpSend = undefined;
        this.videoSrtcpReceive?.destroy(); this.videoSrtcpReceive = undefined;
        if (this.mediaDiagnostics) {
            this.lastMediaDiagnostics = { ...this.mediaDiagnostics, endedAt: Date.now() };
            this.notify("independent-call-ended", { mediaDiagnostics: { ...this.lastMediaDiagnostics },
                videoDiagnostics: { ...(this.lastVideoDiagnostics || {}) } });
        }
        const relay = this.relay || this.outgoing?.relay;
        this.relay = null;
        if (this.outgoing) this.outgoing.relay = null;
        relay?.close(sendEnd);
        this.opus?.close();
        this.opus = null;
        this.srtpSend?.destroy(); this.srtpSend = null;
        this.srtpReceive?.destroy(); this.srtpReceive = null;
        this.srtcpSend?.destroy(); this.srtcpSend = null;
        this.srtcpReceive?.destroy(); this.srtcpReceive = null;
        this.srtcpEnabled = undefined;
        this.masterKeySalt?.fill(0); this.masterKeySalt = null;
        this.rtpSender = null;
        this.sentRtpPackets = 0;
        this.sentRtpOctets = 0;
        this.receivedRtcpPackets = 0;
        this.lastPeerReports = [];
        this.rtpReception = null;
        this.confirmed = false;
        this.answerSignalSent = false;
        this.answerInFlight = false;
        this.mediaDiagnostics = undefined;
        this.offerDiagnostics = undefined;
        this.lastMediaDiagnosticAt = 0;
        this.lastVideoDiagnosticAt = 0;
        this.relayTask = undefined;
        if (this.mediaDiagnosticsTimer) clearInterval(this.mediaDiagnosticsTimer);
        this.mediaDiagnosticsTimer = undefined;
    }
    registerRelay() {
        if (this.relayTask) return this.relayTask;
        const operation = this._registerRelay();
        this.relayTask = operation;
        operation.finally(() => { if (this.relayTask === operation) this.relayTask = undefined; }).catch(() => {});
        return operation;
    }
    /** Prepare the known audio subset and register a caller relay from 401. */
    async registerOutgoingRelay(preflight, calleeId, callType = 1) {
        if (this.pending || this.outgoing || this.relay?.registered)
            throw new Error("Đang có cuộc gọi khác; kết thúc trước khi thử gọi đi");
        if (![1, 3].includes(callType)) throw new Error("Outgoing callType phải là 1 (audio) hoặc 3 (video)");
        if (!preflight || preflight.status !== 0 || !Array.isArray(preflight.servers) || !preflight.servers.length)
            throw new Error("Preflight không có relay candidate hợp lệ");
        const asNativeUint32 = (value, name) => {
            const number = Number(value);
            if (!Number.isInteger(number) || number < -2147483648 || number > 0xffffffff)
                throw new Error(`${name} ngoài phạm vi uint32 native`);
            return number >>> 0;
        };
        const candidates = preflight.servers.slice(0, 8);
        const failures = [];
        const localConfig = preflight.zrtcConfig || {};
        if (![1, 2].includes(localConfig.srtpMode)) throw new Error("401 zrtc_config không có SRTP profile được hỗ trợ");
        const localSrtcp = localConfig.srtpRTCP === true || localConfig.srtpRTCP === 1 ? 1 :
            localConfig.srtpRTCP === undefined || localConfig.srtpRTCP === false || localConfig.srtpRTCP === 0 ? 0 : -1;
        if (localSrtcp !== 0) throw new Error("Caller trial hiện chỉ hỗ trợ profile đã kiểm thử với RTCP clear");
        if (localConfig.srtpNoSeq || localConfig.noSeq) throw new Error("Caller trial chưa hỗ trợ srtpNoSeq");
        const codecInfo = { name: "opus/16000/1", payload: 112, frmPtime: 20, dynamicFptime: 0 };
        const codec = selectNativeOpusCodec([codecInfo]);
        const capabilities = callType === 3
            ? buildZrtcVideoCapabilities({ srtpMode: localConfig.srtpMode, srtcp: 0,
                packetMode: Number.isInteger(localConfig.packetMode) ? localConfig.packetMode : 2,
                newZrtc: localConfig.newZrtc })
            : {
                callType: 0, newZrtc: Number.isInteger(localConfig.newZrtc) ? localConfig.newZrtc : 0,
                platform: 2, packetMode: Number.isInteger(localConfig.packetMode) ? localConfig.packetMode : 2,
                gccMode: 0, srtpMode: localConfig.srtpMode, sP2P: 0, srtcp: 0,
                gccAudio: 0, gccSVLR: 0, tpType: 0, spTcp: 0, gccEarlyCall: 0,
            };
        const mediaOffer = { uidTo: preflight.fromId, uidFrom: preflight.toId,
            sessionId: preflight.sessionId, zrtcConfig: localConfig, extendData: JSON.stringify(capabilities) };
        const opus = new ZrtcOpusGateway(codec);
        let mediaSecurity;
        try { mediaSecurity = this.prepareRtpSecurity(mediaOffer, codec); }
        catch (error) { opus.close(); throw new Error(`Caller RTP/SRTP chưa sẵn sàng: ${error.message}`); }
        for (const [candidateOffset, candidate] of candidates.entries()) {
            const candidateIndex = candidateOffset + 1;
            this.notify("outgoing-call-stage", { flow: "relay", stage: "candidate-start",
                candidateIndex, candidateCount: candidates.length });
            const address = candidate.rtpAddress;
            const split = address.lastIndexOf(":");
            const host = address.slice(0, split).replace(/^\[|\]$/g, "");
            const port = Number(address.slice(split + 1));
            if (split < 0 || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
                failures.push("invalid-endpoint");
                this.notify("outgoing-call-error", { flow: "relay", stage: "candidate-endpoint",
                    candidateIndex, errorName: "InvalidEndpoint", message: "Candidate RTP endpoint is invalid" });
                continue;
            }
            let relay;
            try {
                relay = await this.openRelay({ isCaller: true,
                    userId: asNativeUint32(preflight.fromId, "fromId"),
                    partnerId: asNativeUint32(preflight.toId, "toId"),
                    callId: preflight.callId, sessionId: preflight.sessionId, subcommand: 2 },
                { address: host, port }, {
                    onError: error => this.notify("independent-error", { message: `Caller relay lỗi: ${error.message}` }),
                    onMedia: packet => this.receiveRelayMedia(packet),
                });
                this.outgoing = { callId: preflight.callId, calleeId: String(calleeId), preflight, relay,
                    candidate: { address: host, port, rtpAddress: candidate.rtpAddress, rtcpAddress: candidate.rtcpAddress },
                    codecInfo, capabilities, callType, stage: "relay-registered", at: Date.now() };
                this.relay = relay;
                this.opus = opus;
                this.installRtpSecurity(mediaSecurity);
                if (callType === 3) this.prepareVideoBridge(97, this.asNativeUint32(preflight.fromId), this.asNativeUint32(preflight.toId), localConfig.packetMode);
                this.mediaDiagnostics = {
                    relayAudio: 0, relayRtcp: 0, invalidHeader: 0, wrongPayloadType: 0,
                    wrongSsrc: 0, srtpAuthenticated: 0, srtpRejected: 0, invalidRtp: 0,
                    srtpAuthFailures: 0, srtpReplayRejected: 0, srtpOtherRejected: 0,
                    opusDecoded: 0, opusDecodeFailed: 0, deliveredToBrowser: 0,
                    browserPcmSamples: 0, pcmHeldBeforeConfirmation: 0, opusEncodedPackets: 0,
                    relayRtpSent: 0, relayRtpSendErrors: 0, rtcpParsed: 0, srtcpRejected: 0,
                };
                this.mediaDiagnosticsTimer = setInterval(() => this.reportMediaDiagnostics(true), 1000);
                this.mediaDiagnosticsTimer.unref?.();
                this.notify("independent-outgoing-relay", { registered: true, callId: preflight.callId,
                    candidateIndex, candidateCount: candidates.length,
                    codecReady: true, srtpRtpReady: true, mediaReady: false, ringing: false });
                this.notify("outgoing-call-stage", { flow: "relay", stage: "candidate-registered",
                    candidateIndex, candidateCount: candidates.length });
                this.notify("independent-state", this.status());
                return { registered: true, callId: preflight.callId, candidateIndex,
                    candidateCount: candidates.length, codecReady: true, srtpRtpReady: true, mediaReady: false, ringing: false };
            } catch (error) {
                failures.push(error instanceof Error ? error.message : "relay-failed");
                this.notify("outgoing-call-error", { flow: "relay", stage: "candidate-registration",
                    candidateIndex, ...safeCallError(error) });
            }
        }
        opus.close(); mediaSecurity.protect.destroy(); mediaSecurity.srtcpProtect?.destroy();
        mediaSecurity.srtcpUnprotect?.destroy(); mediaSecurity.masterKeySalt.fill(0);
        throw new Error(`Không đăng ký được relay caller (${failures.filter(Boolean).length}/${candidates.length} candidate)`);
    }
    buildOutgoingRequest() {
        const outgoing = this.outgoing;
        if (!outgoing?.relay?.registered || !this.opus || !this.srtpSend || outgoing.stage !== "relay-registered")
            throw new Error("Caller relay/media chưa sẵn sàng cho /request");
        return { calleeId: outgoing.calleeId, callId: String(outgoing.callId),
            rtpAddress: outgoing.candidate.rtpAddress, rtcpAddress: outgoing.candidate.rtcpAddress,
            codec: JSON.stringify([outgoing.codecInfo]), session: outgoing.preflight.sessionId,
            extendData: JSON.stringify(outgoing.capabilities),
            // Native callers also send params.video.enable, but a live test on
            // 2026-10-25 showed the peer changing its inbound stream shape when
            // this field appeared, which broke the previously working receive
            // path. Keep it opt-in until the peer behavior is understood.
            ...(outgoing.callType === 3 && process.env.VIDEO_REQUEST_PARAMS === "1"
                ? { video: { enable: 1 } } : {}) };
    }
    beginOutgoingRequest() {
        if (!this.outgoing || this.outgoing.stage !== "relay-registered") throw new Error("Caller chưa ở phase relay-registered");
        this.outgoing.stage = "request-in-flight";
    }
    rollbackOutgoingRequest() {
        if (this.outgoing?.stage === "request-in-flight") this.outgoing.stage = "relay-registered";
        this.notify("independent-state", this.status());
    }
    markOutgoingRequestSent() {
        if (!this.outgoing) throw new Error("Outgoing call đã kết thúc trong lúc gửi /request");
        if (this.outgoing.stage === "request-in-flight") this.outgoing.stage = "request-sent";
        this.notify("independent-outgoing-invite", { callId: this.outgoing.callId, ringing: false, waitingForRemote: true });
        this.notify("independent-state", this.status());
    }
    prepareOutgoingAnswer() {
        const outgoing = this.outgoing;
        if (!outgoing?.answer || outgoing.answer.status !== 0) throw new Error("Chưa có answer thành công cho outgoing call");
        const codec = selectNativeOpusCodec(outgoing.answer.codecs);
        if (codec.name !== this.codec?.name || codec.payloadType !== this.codec?.payloadType)
            throw new Error("Answer chọn codec khác caller codec đang chuẩn bị");
        const answerCapabilities = outgoing.answer.extendData ? JSON.parse(outgoing.answer.extendData) : {};
        if (!answerCapabilities || typeof answerCapabilities !== "object" || Array.isArray(answerCapabilities))
            throw new Error("Answer extendData không phải object");
        const configuredPacketMode = Number.isInteger(outgoing.preflight.zrtcConfig?.packetMode) && outgoing.preflight.zrtcConfig.packetMode >= 1
            ? outgoing.preflight.zrtcConfig.packetMode : 2;
        // The receiving side selects its depacketizer from *its own* packetMode,
        // which the answer reports. Adopt that value instead of forcing ours.
        this.outgoingAnswerPacketMode = Number.isInteger(answerCapabilities.packetMode)
            ? answerCapabilities.packetMode : null;
        const packetMode = this.outgoingAnswerPacketMode ?? configuredPacketMode;
        const answerVideoCodecs = Array.isArray(answerCapabilities.video?.codec)
            ? answerCapabilities.video.codec.filter(item => item && typeof item === "object" &&
                typeof item.name === "string" && Number.isInteger(item.payload)) : [];
        const videoPayload = answerVideoCodecs.find(item => item.name.toLowerCase() === "h264")?.payload ?? 97;
        const offer = { uidTo: outgoing.preflight.fromId, uidFrom: outgoing.preflight.toId,
            sessionId: outgoing.preflight.sessionId, zrtcConfig: outgoing.preflight.zrtcConfig,
            extendData: outgoing.answer.extendData || "{}" };
        const security = this.prepareRtpSecurity(offer, codec);
        this.installRtpSecurity(security);
        if (outgoing.callType === 3) this.prepareVideoBridge(videoPayload, this.asNativeUint32(outgoing.preflight.fromId), this.asNativeUint32(outgoing.preflight.toId), packetMode);
        outgoing.stage = "answer-media-ready";
        return { callId: outgoing.callId, calleeId: outgoing.calleeId };
    }
    confirmOutgoingAnswer(callId) {
        if (!this.outgoing || this.outgoing.callId !== callId || this.outgoing.stage !== "answer-media-ready")
            throw new Error("Outgoing answer ACK không khớp media-ready call");
        this.confirmed = true;
        this.videoBridge?.setConfirmed(true);
        if (this.videoBridge && this.relay?.registered) {
            this.relay.sendLocalCameraState(true, 0);
            this.videoCameraOnSignalsSent = (this.videoCameraOnSignalsSent || 0) + 1;
            this.relay.sendVideoSuspend(false, 0);
            this.videoCameraStateSent = (this.videoCameraStateSent || 0) + 1;
            this.notify("independent-video-camera-state", { callId, enabled: true, direction: "outgoing",
                localCameraSignalsSent: this.videoCameraOnSignalsSent, suspendSignalsSent: this.videoCameraStateSent });
        }
        this.outgoing.stage = "confirmed";
        this.notify("independent-confirmed", { callId, confirmed: true, direction: "outgoing" });
        this.notify("independent-state", this.status());
    }
    async _registerRelay() {
        const pending = this.pending;
        if (!pending || Date.now() - pending.at > 60000) throw new Error("Cần lời mời gọi mới để đăng ký relay");
        if (this.relay?.registered) return { registered: true, mediaReady: false, reused: true };
        const address = pending.offer.rtpAddress;
        const split = address.lastIndexOf(":");
        const host = address.slice(0,split).replace(/^\[|\]$/g,"");
        const port = Number(address.slice(split+1));
        if (split < 0 || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error("Offer dùng địa chỉ relay chưa được hỗ trợ; chưa gửi gói tin");
        const codec = selectNativeOpusCodec(pending.offer.codecs);
        const opus = new ZrtcOpusGateway(codec);
        let mediaSecurity;
        try { mediaSecurity = this.prepareRtpSecurity(pending.offer, codec); }
        catch (error) {
            opus.close();
            this.notify("independent-error", { message: `RTP/RTCP crypto chưa sẵn sàng: ${error.message}` });
            throw error;
        }
        const asNativeUint32 = value => {
            const number = Number(value);
            if (!Number.isInteger(number) || number < -2147483648 || number > 4294967295) throw new Error("ID relay ngoài phạm vi uint32 native");
            return number >>> 0;
        };
        const offer = pending.offer;
        let relay;
        try {
            relay = await ZrtpRelaySession.open({isCaller:false,userId:asNativeUint32(offer.uidTo),
                partnerId:asNativeUint32(offer.uidFrom),callId:offer.callId,sessionId:offer.sessionId,subcommand:2},
                {address:host,port}, {
                    onError: error => this.notify("independent-error", { message: `Relay độc lập lỗi: ${error.message}` }),
                    onMedia: packet => this.receiveRelayMedia(packet),
                });
        } catch (error) {
            opus.close();
            mediaSecurity?.protect.destroy(); mediaSecurity?.srtcpProtect?.destroy(); mediaSecurity?.srtcpUnprotect?.destroy(); mediaSecurity?.masterKeySalt.fill(0);
            throw error;
        }
        // The call may have been cancelled while registration was pending.
        if (this.pending !== pending) {
            relay.close(false); opus.close(); mediaSecurity?.protect.destroy(); mediaSecurity?.srtcpProtect?.destroy(); mediaSecurity?.srtcpUnprotect?.destroy(); mediaSecurity?.masterKeySalt.fill(0);
            throw new Error("Lời mời đã hết hạn trong lúc đăng ký relay");
        }
        this.relay = relay;
        this.opus?.close();
        this.opus = opus;
        if (mediaSecurity) this.installRtpSecurity(mediaSecurity);
        if (offer.videoRequested === true) {
            const videoPayload = offer.videoCodecs?.find(item => item.name.toLowerCase() === "h264")?.payload;
            if (videoPayload === undefined) throw new Error("Offer video chưa có payload H264 dạng name/payload");
            this.prepareVideoBridge(videoPayload, this.asNativeUint32(offer.uidTo), this.asNativeUint32(offer.uidFrom), offer.zrtcConfig?.packetMode);
        }
        const summary = { registered: true, codecReady: true, srtpRtpReady: Boolean(this.srtpSend), srtcpReady: this.srtcpEnabled === false || Boolean(this.srtcpSend && this.srtcpReceive), codec: codec.name,
            mediaReady: false, persistentSocket: true, keepaliveMs: 6000 };
        this.receiveCount = 0;
        this.mediaDiagnostics = {
            relayAudio: 0, relayRtcp: 0, invalidHeader: 0, wrongPayloadType: 0,
            wrongSsrc: 0, srtpAuthenticated: 0, srtpRejected: 0, invalidRtp: 0,
            srtpAuthFailures: 0, srtpReplayRejected: 0, srtpOtherRejected: 0,
            opusDecoded: 0, opusDecodeFailed: 0, deliveredToBrowser: 0,
            browserPcmSamples: 0, pcmHeldBeforeConfirmation: 0, opusEncodedPackets: 0,
            relayRtpSent: 0, relayRtpSendErrors: 0, rtcpParsed: 0, srtcpRejected: 0,
        };
        this.mediaDiagnosticsTimer = setInterval(() => this.reportMediaDiagnostics(true), 1000);
        this.mediaDiagnosticsTimer.unref?.();
        this.notify("independent-relay", summary);
        this.notify("independent-state", this.status());
        return summary;
    }
    buildAcceptedAnswer() {
        const offer = this.pending?.offer;
        if (!offer || !this.relay?.registered || !this.opus || !this.codec || !this.srtpSend)
            throw new Error("Cần offer, relay, codec và RTP/SRTP trước khi thử answer");
        if (offer.videoRequested === true && (!this.videoBridge || !offer.videoCodecs?.some(item => item.name.toLowerCase() === "h264")))
            throw new Error("Offer video chưa có H264 payload hoặc video bridge");
        if (this.answerSignalSent) throw new Error("Answer đã gửi; đang chờ ACK của peer");
        if (this.srtpProfile !== 1 || this.srtcpEnabled !== false)
            throw new Error("Answer trial hiện chỉ hỗ trợ SRTP profile1 với RTCP clear đã khớp");
        const remote = offer.extendData ? JSON.parse(offer.extendData) : {};
        const local = offer.zrtcConfig || {};
        const packetMode = local.packetMode ?? 2;
        if (remote.packetMode !== packetMode) throw new Error("packetMode chưa khớp cấu hình native mặc định");
        if (offer.rtpAddress !== offer.rtcpAddress)
            throw new Error("Chưa hỗ trợ answer khi RTP và RTCP dùng relay endpoint khác nhau");
        const selected = offer.codecs.find(item => item.name === this.codec.name && item.payload === this.codec.payloadType);
        if (!selected) throw new Error("Codec đang mở không có trong offer");
        const endpoint = this.relay.relay;
        const relayAddress = `${endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address}:${endpoint.port}`;
        // Explicit, conservative capability candidate: advertise only relay UDP,
        // profile1 RTP SRTP and the negotiated clear-RTCP path implemented here.
        const capabilities = offer.videoRequested === true
            ? buildZrtcVideoCapabilities({ srtpMode: this.srtpProfile, srtcp: 0, packetMode })
            : { packetMode, srtpMode: this.srtpProfile, srtcp: 0, sP2P: 0,
                gccMode: 0, gccAudio: false, gccSVLR: false, gccEarlyCall: false, tpType: 0, spTcp: 0 };
        return buildZrtcAcceptedAnswer({ offer, codecs: [selected], rtpAddress: relayAddress,
            rtcpAddress: relayAddress, capabilities });
    }
    beginAnswerSignal() {
        if (!this.pending || !this.relay?.registered) throw new Error("Offer/relay ended before answer response");
        this.answerInFlight = true;
    }
    rollbackAnswerSignal() {
        this.answerInFlight = false;
        if (!this.confirmed) this.answerSignalSent = false;
        this.notify("independent-state", this.status());
    }
    markAnswerSignalSent() {
        this.answerInFlight = false;
        this.answerSignalSent = true;
        this.notify("independent-answer", { signalAccepted: true, waitingForPeerAck: true, confirmed: false });
        this.notify("independent-state", this.status());
    }
    prepareRtpSecurity(offer, codec) {
        const local = offer.zrtcConfig || {};
        const remote = offer.extendData ? JSON.parse(offer.extendData) : {};
        if (!remote || typeof remote !== "object" || Array.isArray(remote)) throw new Error("extendData không phải object");
        const mode = local.srtpMode;
        if (![1, 2].includes(mode) || remote.srtpMode !== mode) throw new Error("SRTP profile offer/backend không khớp hoặc chưa hỗ trợ");
        if (local.srtpNoSeq || local.noSeq) throw new Error("Native srtpNoSeq chưa được hỗ trợ");
        // Native ZRtcConfig reads srtpRTCP as a JSON boolean; an absent JsonCpp
        // member is false. The captured offer omitted it and negotiated srtcp=0.
        const localSrtcp = local.srtpRTCP === undefined ? 0 :
            local.srtpRTCP === true || local.srtpRTCP === 1 ? 1 :
            local.srtpRTCP === false || local.srtpRTCP === 0 ? 0 : undefined;
        const remoteSrtcp = remote.srtcp === undefined ? 0 : remote.srtcp;
        if (localSrtcp === undefined) throw new Error("Cấu hình local srtpRTCP không hợp lệ; từ chối tạo media context");
        if (remoteSrtcp !== 0 && remoteSrtcp !== 1) throw new Error("Giá trị srtcp trong offer không hợp lệ");
        if (remoteSrtcp !== localSrtcp) throw new Error("Local/remote srtcp không khớp theo capability gate native");
        if (local.packetMode !== undefined && remote.packetMode !== local.packetMode)
            throw new Error("packetMode offer/backend không khớp");
        const masterKeySalt = selectZrtcSrtpKey(mode, offer.sessionId, typeof local.srtpKey === "string" ? local.srtpKey : "");
        const ssrc = this.asNativeUint32(offer.uidTo);
        const initialSequenceNumber = randomInt(1, 0x8000);
        const sender = new RtpAudioSender({ ssrc, payloadType: codec.payloadType, clockRate: codec.sampleRate,
            timestampStep: codec.sampleRate * codec.frameMs / 1000, initialSequenceNumber });
        const protect = new SrtpRtpContext({ masterKeySalt, profile: mode, direction: "send", ssrc,
            initialRoc: 0, initialSequenceNumber });
        const srtcpProtect = localSrtcp ? new SrtcpContext({ masterKeySalt, profile: mode, direction: "send" }) : null;
        const srtcpUnprotect = localSrtcp ? new SrtcpContext({ masterKeySalt, profile: mode, direction: "receive" }) : null;
        return { masterKeySalt, profile: mode, localSsrc: ssrc, remoteSsrc: this.asNativeUint32(offer.uidFrom), sender, protect,
            srtcpProtect, srtcpUnprotect, srtcpEnabled: Boolean(localSrtcp), codec };
    }
    installRtpSecurity(security) {
        this.masterKeySalt?.fill(0);
        this.masterKeySalt = security.masterKeySalt;
        this.srtpSend?.destroy(); this.srtpSend = security.protect;
        this.srtpReceive?.destroy(); this.srtpReceive = null;
        this.srtcpSend?.destroy(); this.srtcpSend = security.srtcpProtect;
        this.srtcpReceive?.destroy(); this.srtcpReceive = security.srtcpUnprotect;
        this.srtcpEnabled = security.srtcpEnabled;
        this.rtpSender = security.sender;
        this.remoteSsrc = security.remoteSsrc;
        this.codec = security.codec;
        this.srtpProfile = security.profile;
        this.sentRtpPackets = 0;
        this.sentRtpOctets = 0;
        this.receivedRtcpPackets = 0;
        this.lastPeerReports = [];
        this.rtpReception = new RtpReceptionStats(this.codec.sampleRate);
    }
    asNativeUint32(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < -2147483648 || number > 0xffffffff) throw new Error("ID relay ngoài phạm vi uint32 native");
        return number >>> 0;
    }
    prepareVideoBridge(payloadType, localSsrc, remoteSsrc, packetMode) {
        if (!this.masterKeySalt || !this.relay?.registered || !this.srtpProfile)
            throw new Error("Video SRTP chưa có relay/key/profile");
        this.videoBridge?.close();
        const initialSequenceNumber = randomInt(1, 0x8000);
        const protect = new SrtpRtpContext({ masterKeySalt: this.masterKeySalt, profile: this.srtpProfile, direction: "send", ssrc: localSsrc, initialRoc: 0, initialSequenceNumber });
        const unprotect = new SrtpRtpContext({ masterKeySalt: this.masterKeySalt, profile: this.srtpProfile, direction: "receive", ssrc: remoteSsrc, initialRoc: 0, initialSequenceNumber: 0 });
        const makeVideoUnprotect = (ssrc, sequenceNumber) => new SrtpRtpContext({ masterKeySalt: this.masterKeySalt, profile: this.srtpProfile, direction: "receive", ssrc, initialRoc: 0, initialSequenceNumber: sequenceNumber });
        this.videoBridge = new VideoRtpBridge({ relay: this.relay, codec: "h264", payloadType, packetMode,
            // The peer sends no RTP header extensions. Emit the native
            // RapidSync/SVC block only when explicitly comparing with Zalo PC.
            extensions: this.videoExtensionsOverride ?? process.env.VIDEO_RTP_EXTENSIONS === "1",
            // Live packetMode-2 peers address every NAL with its Annex-B start
            // code. "balanced" reproduces the native packetMode-1 splitter.
            packetFormat: this.videoPacketFormatOverride
                ?? (process.env.VIDEO_PACKETIZATION === "balanced" ? "balanced"
                    : process.env.VIDEO_PACKETIZATION === "rfc6184" ? "rfc6184" : "nal"),
            // Live Zalo video calls use PT97 and PT98 in the same authenticated
            // SSRC/sequence space. Native registers every candidate receive
            // codec, so retain both candidate payloads plus its legacy PT100.
            receivePayloadTypes: [...new Set([payloadType, 97, 98, 100])], localSsrc, remoteSsrc, initialSequenceNumber, protect, unprotect, unprotectFactory: makeVideoUnprotect,
            onFrame: frame => {
                this.onDecodedVideo?.(frame);
                // Opt-in diagnostic: keep the first keyframes so they can be
                // decoded offline when a live peer renders black.
                if (process.env.VIDEO_DUMP_DIR && frame.keyFrame) {
                    this.videoDumpCount = (this.videoDumpCount || 0) + 1;
                    if (this.videoDumpCount <= 3) {
                        try { writeFileSync(`${process.env.VIDEO_DUMP_DIR}/in-key-${this.videoDumpCount}.h264`, Buffer.from(frame.data)); }
                        catch { /* diagnostic only */ }
                    }
                }
                const encoded = Buffer.from(frame.data).toString("base64");
                if (encoded.length <= 12 * 1024 * 1024)
                    this.notify("independent-video-frame", { timestamp: frame.timestamp, keyFrame: frame.keyFrame, codec: frame.codec || this.videoBridge?.receiveCodec || "h264", frameLength: frame.data.length, frame: encoded });
            } });
        this.videoBridge.setConfirmed(this.confirmed === true);
        this.videoPacketMode = packetMode;
        this.videoSentPayloadType = payloadType;
        this.videoLocalSsrc = localSsrc;
        this.videoRemoteSsrc = remoteSsrc;
        this.videoNegotiatedPacketMode = packetMode;
        this.videoDirection = this.outgoing ? "outgoing" : "incoming";
        this.videoRelayRtpPackets = 0;
        this.videoRelayRtcpPackets = 0;
        this.videoPliSent = 0;
        this.videoRtcpReportsSent = 0;
        this.videoCameraStateSent = 0;
        this.videoCameraOnSignalsSent = 0;
        this.videoSrtcpSend?.destroy(); this.videoSrtcpReceive?.destroy();
        this.videoSrtcpSend = this.srtcpEnabled ? new SrtcpContext({ masterKeySalt: this.masterKeySalt, profile: this.srtpProfile, direction: "send" }) : null;
        this.videoSrtcpReceive = this.srtcpEnabled ? new SrtcpContext({ masterKeySalt: this.masterKeySalt, profile: this.srtpProfile, direction: "receive" }) : null;
        this.videoPayloadType = payloadType;
        this.notify("independent-state", this.status());
        return this.videoBridge;
    }
    /** Live A/B switch for the outgoing video packetization. */
    setVideoFormat(format, extensions, payloadType) {
        if (!["nal", "balanced", "rfc6184"].includes(format))
            throw new Error("Video packet format phải là nal, balanced hoặc rfc6184");
        this.videoPacketFormatOverride = format;
        if (typeof extensions === "boolean") this.videoExtensionsOverride = extensions;
        // Swap in place: recreating the bridge would reset SRTP/sequence and the
        // peer would reject the new sequence space as replay.
        if (this.videoBridge && this.confirmed)
            this.videoBridge.setPacketFormat(format, this.videoExtensionsOverride, payloadType);
        this.notify("independent-video-format", { format, extensions: this.videoExtensionsOverride, payloadType });
        return { format, extensions: this.videoExtensionsOverride ?? null,
            payloadType: this.videoBridge?.sentPayloadType ?? null, active: Boolean(this.videoBridge) };
    }
    sendVideoPli() {
        if (!this.videoBridge || !this.relay?.registered || !this.masterKeySalt) throw new Error("Video bridge chưa sẵn sàng");
        const senderSsrc = this.asNativeUint32(this.pending?.offer?.uidTo ?? this.outgoing?.preflight?.fromId ?? 0);
        const mediaSsrc = this.asNativeUint32(this.videoBridge.remoteVideoSsrc ?? this.pending?.offer?.uidFrom ?? this.outgoing?.preflight?.toId ?? 0);
        // ZaloCall uses compound RTCP. Mirror SR/RR + SDES + PLI rather than a
        // reduced-size standalone PLI, which older receivers may discard. The
        // native RTCPSender emits SR once this side has sent RTP.
        const report = buildCompoundRtcpPli(senderSsrc, mediaSsrc, `zrtc-${senderSsrc}`,
            this.videoSenderInfo(this.videoBridge));
        this.relay.sendVideoRtcp(this.videoSrtcpSend ? this.videoSrtcpSend.protect(report) : report);
        this.videoPliSent = (this.videoPliSent || 0) + 1;
        this.notify("independent-video-pli", { sent: true });
    }

    videoSenderInfo(bridge) {
        if (!bridge || !bridge.sentPackets) return undefined;
        const now = Date.now();
        return {
            ntpSeconds: Math.floor(now / 1000) + 0x83aa7e80,
            ntpFraction: Math.floor(((now % 1000) / 1000) * 0x100000000) >>> 0,
            rtpTimestamp: bridge.lastSentTimestamp >>> 0,
            packetCount: bridge.sentPackets,
            octetCount: bridge.sentOctets,
        };
    }
    sendVideoRtcpReport() {
        if (this.confirmed !== true || !this.videoBridge || !this.relay?.registered) return false;
        const senderSsrc = this.asNativeUint32(this.videoBridge.localVideoSsrc);
        const block = this.videoBridge.buildReceptionReportBlock(Date.now());
        // Native RTCPSender builds SR (not RR) while the video sender is active.
        const report = buildCompoundRtcpReport({ ssrc: senderSsrc, cname: `zrtc-${senderSsrc}`,
            reportBlocks: block ? [block] : [], senderInfo: this.videoSenderInfo(this.videoBridge) });
        this.relay.sendVideoRtcp(this.videoSrtcpSend ? this.videoSrtcpSend.protect(report) : report);
        this.videoRtcpReportsSent = (this.videoRtcpReportsSent || 0) + 1;
        return true;
    }

    sendBrowserVideoFrame(frame, timestamp90k, keyFrame = false) {
        if (!(frame instanceof Uint8Array) || !Number.isInteger(timestamp90k)) throw new TypeError("Encoded video frame and timestamp are required");
        if (!this.videoBridge) throw new Error("Video RTP bridge chưa được chuẩn bị");
        if (process.env.VIDEO_DUMP_DIR && keyFrame) {
            this.outVideoDumpCount = (this.outVideoDumpCount || 0) + 1;
            if (this.outVideoDumpCount <= 3) {
                try { writeFileSync(`${process.env.VIDEO_DUMP_DIR}/out-key-${this.outVideoDumpCount}.h264`, Buffer.from(frame)); }
                catch { /* diagnostic only */ }
            }
        }
        const sent = this.videoBridge.sendFrame(frame, timestamp90k, keyFrame);
        // The periodic diagnostics timer publishes counters; doing that for
        // every video frame needlessly serializes the entire call state.
        return sent;
    }

    sendBrowserPcm(mono48k) {
        if (!this.relay?.registered || !this.opus || !this.srtpSend || !this.rtpSender)
            throw new Error("Relay/Opus/SRTP RTP chưa sẵn sàng");
        this.mediaDiagnostics.browserPcmSamples += mono48k.length;
        if (this.confirmed !== true) {
            this.mediaDiagnostics.pcmHeldBeforeConfirmation += mono48k.length;
            this.reportMediaDiagnostics();
            return 0;
        }
        const frames = this.opus.pushBrowserPcm48k(mono48k);
        this.mediaDiagnostics.opusEncodedPackets += frames.length;
        for (const payload of frames) {
            try {
                const rtp = this.rtpSender.packet(payload);
                this.relay.sendAudio(this.srtpSend.protect(rtp));
                this.mediaDiagnostics.relayRtpSent++;
                this.sentRtpPackets = (this.sentRtpPackets || 0) + 1;
                this.sentRtpOctets = (this.sentRtpOctets || 0) + payload.length;
            } catch (error) {
                this.mediaDiagnostics.relayRtpSendErrors++;
                this.reportMediaDiagnostics();
                throw error;
            }
        }
        this.reportMediaDiagnostics();
        return frames.length;
    }
    /** Caller must supply the negotiated CNAME and invoke only after call confirmation. */
    sendRtcpReport(cname) {
        if (this.confirmed !== true) throw new Error("RTCP report is gated until call confirmation");
        if (!this.relay?.registered || !this.rtpSender || this.srtcpEnabled === undefined)
            throw new Error("Relay and negotiated RTCP security are not ready");
        const now = Date.now();
        const senderInfo = this.sentRtpPackets ? {
            ntpSeconds: (Math.floor(now / 1000) + 2208988800) >>> 0,
            ntpFraction: Math.floor((now % 1000) * 0x100000000 / 1000) >>> 0,
            rtpTimestamp: this.rtpSender.counters().timestamp,
            packetCount: this.sentRtpPackets >>> 0,
            octetCount: this.sentRtpOctets >>> 0,
        } : undefined;
        const reportBlock = this.rtpReception?.reportBlock(this.remoteSsrc, now);
        const report = buildCompoundRtcpReport({ ssrc: this.rtpSender.counters().ssrc, cname, senderInfo,
            reportBlocks: reportBlock ? [reportBlock] : [] });
        this.relay.sendAudioRtcp(this.srtcpEnabled ? this.srtcpSend.protect(report) : report);
    }
    receiveRelayMedia(packet) {
        const diagnostic = this.mediaDiagnostics;
        if (!diagnostic) return;
        if (packet.kind === "video") {
            this.videoRelayRtpPackets = (this.videoRelayRtpPackets || 0) + 1;
            if (!this.videoBridge) return;
            this.videoBridge.receiveRtp(packet.payload);
            const now = Date.now();
            if (!this.lastVideoDiagnosticAt || now - this.lastVideoDiagnosticAt >= 1000) {
                this.lastVideoDiagnosticAt = now;
                this.notify("independent-video-media", { packetsReceived: this.videoBridge.receivedPackets, framesReceived: this.videoBridge.receivedFrames, keyFramesReceived: this.videoBridge.receivedKeyFrames, receiveCodec: this.videoBridge.receiveCodec, packetsRejected: this.videoBridge.rejectedPackets, rejectReasons: { ...this.videoBridge.rejectionReasons } });
            }
            return;
        }
        if (packet.kind === "videoRtcp") {
            this.videoRelayRtcpPackets = (this.videoRelayRtcpPackets || 0) + 1;
            if (!this.videoBridge) return;
            try {
                const clear = this.videoSrtcpReceive ? this.videoSrtcpReceive.unprotect(packet.payload) : packet.payload;
                const summaries = parseCompoundRtcp(clear);
                for (const summary of summaries) {
                    if (summary.packetType === 206 && summary.count === 1)
                        this.onVideoKeyFrameRequest?.(summary.mediaSsrc ?? null);
                    if (summary.packetType === 200 && summary.senderInfo)
                        this.videoBridge.noteSenderReport(summary.senderInfo.ntpSeconds, summary.senderInfo.ntpFraction, Date.now());
                }
            } catch { this.notify("independent-video-rtcp", { rejected: true }); }
            return;
        }
        if (packet.kind === "audioRtcp") {
            diagnostic.relayRtcp++;
            if (this.srtcpEnabled === undefined) return;
            try {
                const clear = this.srtcpEnabled ? this.srtcpReceive?.unprotect(packet.payload) : packet.payload;
                if (!clear) return;
                const summaries = parseCompoundRtcp(clear);
                diagnostic.rtcpParsed++;
                this.receivedRtcpPackets = (this.receivedRtcpPackets || 0) + 1;
                this.lastPeerReports = summaries.flatMap(item => item.reportBlocks || []);
                for (const summary of summaries) if (summary.packetType === 200 && summary.senderInfo)
                    this.rtpReception?.setLastSenderReport(summary.senderInfo.ntpSeconds, summary.senderInfo.ntpFraction, Date.now());
                if (this.receivedRtcpPackets === 1 || this.receivedRtcpPackets % 10 === 0)
                    this.notify("independent-rtcp", { authenticated: this.srtcpEnabled, packets: this.receivedRtcpPackets,
                        packetTypes: summaries.map(item => item.packetType), reportBlocks: this.lastPeerReports.length });
            } catch {
                diagnostic.srtcpRejected++;
                // Never log packet bytes, RTCP contents, key material, or authentication errors.
            }
            this.reportMediaDiagnostics();
            return;
        }
        if (packet.kind !== "audio") return;
        diagnostic.relayAudio++;
        if (!this.masterKeySalt || !this.opus || !this.codec) { this.reportMediaDiagnostics(); return; }
        const bytes = Buffer.from(packet.payload);
        if (bytes.length < 22 || bytes[0] >>> 6 !== 2) { diagnostic.invalidHeader++; this.reportMediaDiagnostics(); return; }
        if ((bytes[1] & 0x7f) !== this.codec.payloadType) { diagnostic.wrongPayloadType++; this.reportMediaDiagnostics(); return; }
        const sequenceNumber = bytes.readUInt16BE(2);
        const ssrc = bytes.readUInt32BE(8);
        if (ssrc !== this.remoteSsrc) { diagnostic.wrongSsrc++; this.reportMediaDiagnostics(); return; }
        let clear;
        try {
            if (!this.srtpReceive) this.srtpReceive = new SrtpRtpContext({ masterKeySalt: this.masterKeySalt,
                profile: this.srtpProfile, direction: "receive", ssrc, initialRoc: 0, initialSequenceNumber: sequenceNumber });
            clear = this.srtpReceive.unprotect(bytes);
            diagnostic.srtpAuthenticated++;
        } catch (error) {
            diagnostic.srtpRejected++;
            if (error instanceof Error && error.message === "SRTP authentication failed") diagnostic.srtpAuthFailures++;
            else if (error instanceof Error && /replay|outside replay window/.test(error.message)) diagnostic.srtpReplayRejected++;
            else diagnostic.srtpOtherRejected++;
            this.reportMediaDiagnostics();
            return;
        }
        let rtp;
        try { rtp = parseRtpPacket(clear); }
        catch { diagnostic.invalidRtp++; this.reportMediaDiagnostics(); return; }
        if (rtp.payloadType !== this.codec.payloadType || rtp.ssrc !== this.remoteSsrc) {
            diagnostic.invalidRtp++;
            this.reportMediaDiagnostics();
            return;
        }
        this.rtpReception?.update(rtp.sequenceNumber, rtp.timestamp, Date.now());
        let pcm;
        try { pcm = this.opus.decodeToBrowserPcm48k(rtp.payload); }
        catch { diagnostic.opusDecodeFailed++; this.reportMediaDiagnostics(); return; }
        diagnostic.opusDecoded++;
        this.receiveCount = (this.receiveCount || 0) + 1;
        if (this.onDecodedPcm) {
            this.onDecodedPcm(pcm);
            diagnostic.deliveredToBrowser++;
        }
        if (this.receiveCount === 1 || this.receiveCount % 50 === 0)
            this.notify("independent-media", { kind: "audio", authenticated: true, decodedPackets: this.receiveCount,
                decodedSamples: pcm.length, playedInBrowser: Boolean(this.onDecodedPcm) });
        this.reportMediaDiagnostics();
    }
    reportMediaDiagnostics(force = false) {
        if (!this.mediaDiagnostics) return;
        const now = Date.now();
        if (force && this.videoBridge && this.confirmed === true) {
            try { this.sendVideoRtcpReport(); }
            catch (error) { this.notify("independent-video-rtcp", { rejected: true, message: error?.message || "Không gửi được RTCP video" }); }
        }
        const total = this.mediaDiagnostics.relayAudio + this.mediaDiagnostics.relayRtcp;
        if (!force && total !== 1 && total % 50 !== 0 && now - this.lastMediaDiagnosticAt < 2000) return;
        this.lastMediaDiagnosticAt = now;
        this.notify("independent-media-diagnostics", { ...this.mediaDiagnostics });
        this.notify("independent-state", this.status());
    }
    async probe() {
        const pending = this.pending;
        if (!pending || Date.now() - pending.at > 60000) throw new Error("Cần lời mời gọi mới để kiểm tra relay độc lập");
        const address = pending.offer.rtpAddress;
        const split = address.lastIndexOf(":");
        const host = address.slice(0,split).replace(/^\[|\]$/g,"");
        const port = Number(address.slice(split+1));
        if (split < 0 || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error("Offer dùng địa chỉ relay chưa được hỗ trợ; chưa gửi gói tin");
        const asNativeUint32 = value => {
            const number = Number(value);
            if (!Number.isInteger(number) || number < -2147483648 || number > 4294967295) throw new Error("ID relay ngoài phạm vi uint32 native");
            return number >>> 0;
        };
        const result = await probeZrtpRelay({isCaller:false,userId:asNativeUint32(pending.offer.uidTo),
            partnerId:asNativeUint32(pending.offer.uidFrom),callId:pending.offer.callId,sessionId:pending.offer.sessionId,subcommand:2},
            {address:host,port});
        // Never expose tokens, session IDs, relay response bytes or key material.
        const summary = {status:result.status,registered:result.status === 0,callEstablished:false,probeSocketClosed:true};
        this.notify("independent-relay",summary);
        return summary;
    }
}
