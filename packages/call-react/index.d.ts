export type CallState = "idle" | "preparing" | "relay-ready" | "inviting" | "calling" | "incoming" | "answering" | "ringing" | "connecting" | "connected" | "ending" | "ended" | "error";
export interface CallStateSnapshot {
    gateway: "disconnected" | "connecting" | "connected";
    call: CallState;
    direction: "incoming" | "outgoing" | null;
    media: string;
    incoming: Record<string, unknown> | null;
    stats: Record<string, unknown> | null;
    videoClientStats: Record<string, unknown> | null;
    error: string | null;
    lastEvent: { event: string; data: unknown; at: number } | null;
}
export interface CallEvent { type: string; [key: string]: unknown }
export interface CallClientOptions {
    /** Application-owned call transport. Credentials belong outside this client. */
    gatewayUrl?: string;
    configUrl?: string;
    transport?: CallTransport;
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
export declare class CallTransport {
    request(action: string, payload?: Record<string, unknown>): Promise<unknown>;
    subscribe(handler: (event: CallEvent | string) => void): () => void;
}
export declare class GatewayTransport {
    constructor(options: Record<string, unknown>);
    connect(): Promise<void>;
    disconnect(): void;
    request(action: string, payload?: Record<string, unknown>): Promise<unknown>;
    subscribe(handler: (event: CallEvent | string) => void): () => void;
}
export declare class ZaloCallClient {
    constructor(options?: CallClientOptions);
    readonly state: CallStateSnapshot;
    getSnapshot(): CallStateSnapshot;
    subscribe(listener: () => void): () => void;
    onEvent(listener: (event: string, data: unknown) => void): () => void;
    connect(): Promise<void>;
    disconnect(): void;
    destroy(): void;
    call(peerId: string, options?: { callType?: 1 | 3 }): Promise<unknown>;
    answer(): Promise<unknown>;
    hangup(): Promise<unknown>;
    setMicrophoneMuted(muted: boolean): void;
    setPlaybackMuted(muted: boolean): void;
    setVolume(volume: number): void;
    startVideoCapture(options?: { width?: number; height?: number; frameRate?: number }): Promise<unknown>;
    stopVideoCapture(): Promise<void>;
    startVideoDecoder(options: { codec?: string; onFrame: (frame: VideoFrame) => void }): unknown;
    stopVideoDecoder(): void;
    sendVideoFrame(frame: Uint8Array, timestamp90k: number, keyFrame?: boolean): void;
}
export declare function assertCallTransport(transport: unknown): CallTransport;
export declare function createZaloCallClient(options?: CallClientOptions): ZaloCallClient;
export interface CallFacade {
    client: ZaloCallClient;
    connect(): Promise<void>;
    call(peerId: string, options?: { callType?: 1 | 3 }): Promise<unknown>;
    callAudio(peerId: string): Promise<unknown>;
    answer(): Promise<unknown>;
    hangup(): Promise<unknown>;
    setMuted(muted: boolean): void;
    setVolume(volume: number): void;
    onState(listener: (state: CallStateSnapshot) => void): () => void;
    onEvent(listener: (event: string, data: unknown) => void): () => void;
    readonly state: CallStateSnapshot;
    destroy(): void;
}
export declare function createZaloCall(options?: CallClientOptions): CallFacade;
