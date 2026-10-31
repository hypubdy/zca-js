// Minimal React integration: one hook, one call.
// Copy this file into a Vite/CRA app that proxies /ws and /api to the gateway.
import { useZaloCall } from "../src/react.js";

export function MinimalCall({ friendId }) {
    const { state, connected, online, call, answer, hangup, setMuted } = useZaloCall();

    if (state.call === "incoming") {
        return (
            <button onClick={answer}>
                Nhận cuộc gọi
            </button>
        );
    }

    if (state.call !== "idle" && state.call !== "error") {
        return (
            <div>
                <p>{state.call}</p>
                <button onClick={() => setMuted(true)}>Tắt mic</button>
                <button onClick={hangup}>Kết thúc</button>
            </div>
        );
    }

    return (
        <div>
            <button disabled={!connected || !online} onClick={() => call(friendId)}>
                Gọi
            </button>
            {state.error && <p role="alert">{state.error}</p>}
        </div>
    );
}
