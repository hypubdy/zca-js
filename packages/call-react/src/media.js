/** Browser media session: microphone capture + WebRTC + speaker playback. */

function waitForIce(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pc.removeEventListener?.("icegatheringstatechange", listener);
            reject(new Error("ICE gathering timed out"));
        }, timeoutMs);
        const listener = () => {
            if (pc.iceGatheringState !== "complete") return;
            clearTimeout(timer);
            pc.removeEventListener?.("icegatheringstatechange", listener);
            resolve();
        };
        pc.addEventListener?.("icegatheringstatechange", listener);
        if (!pc.addEventListener) pc.onicegatheringstatechange = listener;
    });
}

/**
 * Owns one browser WebRTC media session for a Zalo call: microphone capture,
 * remote audio playback through a GainNode and an autoplay fallback element.
 * Audio is audible as soon as the remote track arrives; no extra UI call.
 */
export class CallMediaSession {
    constructor({ context, pc, gain, stream }) {
        this.context = context;
        this.pc = pc;
        this.gain = gain;
        this.stream = stream;
        this.audio = null;
        this.remoteSource = null;
        this.playbackVolume = 1;
        this.playbackMuted = false;
        this.microphoneMuted = false;
    }

    /**
     * Open the media session. Throws a descriptive error when the browser lacks
     * the required APIs, while keeping the caller's state consistent.
     */
    static async open({
        rpc,
        fetchImpl,
        configUrl,
        mediaConstraints,
        iceTimeoutMs,
        deps,
        onState,
        onError,
    }) {
        if (!deps.RTCPeerConnection || !deps.AudioContext || !deps.mediaDevices?.getUserMedia || !fetchImpl) {
            throw new Error("WebRTC microphone APIs require a secure browser context");
        }
        onState({ media: "preparing" });
        const response = await fetchImpl(configUrl);
        if (!response.ok) throw new Error(`Cannot load ICE configuration (${response.status})`);
        const { iceServers = [] } = await response.json();
        const context = new deps.AudioContext({ sampleRate: 48000 });
        await context.resume();
        const pc = new deps.RTCPeerConnection({ iceServers });
        const gain = context.createGain();
        gain.connect(context.destination);
        const session = new CallMediaSession({ context, pc, gain, stream: null });
        try {
            session.stream = await deps.mediaDevices.getUserMedia(mediaConstraints);
            for (const track of session.stream.getTracks()) {
                if (track.kind === "audio") track.enabled = !session.microphoneMuted;
                pc.addTrack(track, session.stream);
            }
            pc.ontrack = (event) => {
                const stream = event.streams?.[0] || new deps.MediaStream([event.track]);
                session.remoteSource?.disconnect?.();
                session.remoteSource = context.createMediaStreamSource(stream);
                session.remoteSource.connect(gain);
                if (deps.Audio) {
                    session.audio = new deps.Audio();
                    session.audio.srcObject = stream;
                    session.audio.muted = true;
                    session.audio.play().catch(() => {});
                }
            };
            pc.onconnectionstatechange = () => {
                onState({ media: pc.connectionState });
                if (pc.connectionState === "failed") onError?.(new Error("WebRTC connection failed"));
            };
            await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
            await waitForIce(pc, iceTimeoutMs);
            const answer = await rpc("media-offer", {
                mode: "zalo",
                input: "mic",
                offer: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription,
            });
            await pc.setRemoteDescription(answer.answer || answer);
            onState({ media: "ready" });
            return session;
        } catch (error) {
            session.close();
            throw error;
        }
    }

    setMicrophoneMuted(muted) {
        this.microphoneMuted = Boolean(muted);
        for (const track of this.stream?.getAudioTracks?.() || []) track.enabled = !this.microphoneMuted;
    }

    setPlaybackMuted(muted) {
        this.playbackMuted = Boolean(muted);
        this.gain.gain.value = this.playbackMuted ? 0 : this.playbackVolume;
    }

    setVolume(volume) {
        const normalized = Math.max(0, Math.min(1, Number(volume)));
        this.playbackVolume = Number.isFinite(normalized) ? normalized : 1;
        this.gain.gain.value = this.playbackMuted ? 0 : this.playbackVolume;
    }

    close() {
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
        for (const track of this.stream?.getTracks?.() || []) track.stop();
        this.remoteSource?.disconnect?.();
        this.audio?.pause?.();
        if (this.audio) this.audio.srcObject = null;
        this.context.close().catch(() => {});
    }
}
