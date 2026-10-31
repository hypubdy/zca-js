// Demo-only controls for the gateway's server-owned Zalo account session.
// This file is intentionally outside @zca-js/call-react: the call library
// must not own login credentials or imply browser-side authentication.
export function createDemoSessionControls(callClient) {
    return {
        startQrLogin: () => callClient.rpc("zalo-login"),
        reconnect: () => callClient.rpc("zalo-reconnect"),
        logout: () => callClient.rpc("zalo-logout"),
        loadFriends: () => callClient.rpc("zalo-friends"),
    };
}

