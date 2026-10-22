/** Static reconstruction of CallController::parseCallConfig, not an SRTP cipher. */
export const ZRTC_SRTP_PROFILES = {
    1: { rtp: "AES_CM_128_HMAC_SHA1_80", rtcp: "AES_CM_128_HMAC_SHA1_80" },
    2: { rtp: "AES_CM_128_HMAC_SHA1_32", rtcp: "AES_CM_128_HMAC_SHA1_80" },
    3: { rtp: "AES_CM_128_NULL_AUTH", rtcp: "AES_CM_128_NULL_AUTH" },
} as const;
export type ZrtcSrtpMode = keyof typeof ZRTC_SRTP_PROFILES;

/**
 * Native 0x10015dc2c..0x10015dcac and 0x10015edd4: use explicit key,
 * otherwise first min(session byte length, 30) bytes of the raw session ID.
 * 0x10029a280 requires AES master key 16 + master salt 14 bytes for modes1..3.
 * Reject incomplete keys instead of silently treating negotiation as successful.
 * This output contains key material; do not log or serialize it.
 */
export function selectZrtcSrtpKey(mode: number, sessionId: string, explicitKey = ""): Uint8Array {
    if (mode !== 1 && mode !== 2 && mode !== 3) throw new RangeError("Unsupported ZRTC SRTP mode");
    if (typeof sessionId !== "string" || typeof explicitKey !== "string") throw new TypeError("SRTP key inputs must be strings");
    const source = Buffer.from(explicitKey || sessionId, "utf8");
    const key = explicitKey ? source : source.subarray(0, 30);
    if (key.length !== 30) throw new RangeError("ZRTC SRTP requires exactly 30 raw key/salt bytes");
    return Uint8Array.from(key);
}

/** Native _parseExtendData 0x1001630d8..0x100163138 enables only equal modes. */
export function negotiateZrtcSrtpMode(localMode: number, remoteMode: number): ZrtcSrtpMode | 0 {
    return localMode === remoteMode && (localMode === 1 || localMode === 2 || localMode === 3) ? localMode : 0;
}
