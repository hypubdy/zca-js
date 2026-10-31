export type GatewayState = "disconnected" | "connecting" | "connected";
export type CallState =
    | "idle"
    | "preparing"
    | "relay-ready"
    | "inviting"
    | "calling"
    | "incoming"
    | "answering"
    | "ringing"
    | "connecting"
    | "connected"
    | "ending"
    | "ended"
    | "error";

export interface ZaloCallState {
    gateway: GatewayState;
    zalo: string;
    call: CallState;
    direction: "incoming" | "outgoing" | null;
    media: string;
    incoming: { action: string; at: number; status: "ringing" } | null;
    independent: Record<string, unknown>;
    cameraState: { enabled: boolean; responseCode?: number | null; at?: string } | null;
    stats: Record<string, unknown> | null;
    videoClientStats: { received: number; decoded: number; errors: number; lastError: string | null; at?: string } | null;
    qr: string | null;
    error: string | null;
    lastEvent: { event: string; data: unknown; at: number } | null;
}

export interface ZaloCallClientOptions {
    gatewayUrl?: string;
    configUrl?: string;
    rpcTimeoutMs?: number;
    iceTimeoutMs?: number;
    reconnectMs?: number;
    autoReconnect?: boolean;
    mediaConstraints?: MediaStreamConstraints;
    WebSocket?: typeof WebSocket;
    RTCPeerConnection?: typeof RTCPeerConnection;
    MediaStream?: typeof MediaStream;
    AudioContext?: typeof AudioContext;
    mediaDevices?: MediaDevices;
    fetch?: typeof fetch;
    Audio?: typeof Audio;
    VideoEncoder?: typeof VideoEncoder;
    MediaStreamTrackProcessor?: typeof MediaStreamTrackProcessor;
    EncodedVideoChunk?: typeof EncodedVideoChunk;
}

export declare class ZaloCallClient {
    constructor(options?: ZaloCallClientOptions);
    readonly state: ZaloCallState;
    socket: unknown;
    getSnapshot(): ZaloCallState;
    subscribe(listener: () => void): () => void;
    onEvent(listener: (event: string, data: unknown) => void): () => void;
    connect(): Promise<void>;
    ensureConnected(): Promise<void>;
    disconnect(): void;
    destroy(): void;
    rpc(action: string, data?: Record<string, unknown>): Promise<any>;
    call(calleeId: string, options?: { callType?: 1 | 3 }): Promise<{ preflight: any; invite: any }>;
    startVideoCapture(options?: { width?: number; height?: number; frameRate?: number }): Promise<any>;
    stopVideoCapture(): Promise<void>;
    startVideoDecoder(options: { codec?: string; onFrame: (frame: VideoFrame) => void }): any;
    stopVideoDecoder(): void;
    sendVideoFrame(frame: Uint8Array, timestamp90k: number, keyFrame?: boolean): void;
    answer(): Promise<any>;
    hangup(): Promise<any>;
    setMicrophoneMuted(muted: boolean): void;
    setPlaybackMuted(muted: boolean): void;
    setVolume(volume: number): void;
}

export declare function createZaloCallClient(options?: ZaloCallClientOptions): ZaloCallClient;

/** Minimal façade: connect on demand, one call, audio handled for you. */
export interface ZaloCallFacade {
    client: ZaloCallClient;
    connect(): Promise<void>;
    call(calleeId: string, options?: { callType?: 1 | 3 }): ReturnType<ZaloCallClient["call"]>;
    callAudio(calleeId: string): ReturnType<ZaloCallClient["call"]>;
    answer(): ReturnType<ZaloCallClient["answer"]>;
    hangup(): ReturnType<ZaloCallClient["hangup"]>;
    setMuted(muted: boolean): void;
    setVolume(volume: number): void;
    onState(listener: (state: ZaloCallState) => void): () => void;
    onEvent(listener: (event: string, data: unknown) => void): () => void;
    readonly state: ZaloCallState;
    destroy(): void;
}

export declare function createZaloCall(options?: ZaloCallClientOptions): ZaloCallFacade;
