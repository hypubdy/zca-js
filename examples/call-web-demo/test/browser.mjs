import { chromium } from "playwright-core";
import fs from "node:fs/promises";

const url = process.env.DEMO_URL || "http://localhost:4317";
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
    ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "vi-VN" });
const errors = [];
const results = [];
page.on("pageerror", (error) => errors.push(error.message));
await fs.mkdir("artifacts", { recursive: true });
try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByText("Đã kết nối backend.", { exact: true }).waitFor();
    await page.screenshot({ path: "artifacts/demo-desktop.png", fullPage: true });
    await page.getByTestId("source-tone").click();
    for (const mode of ["tone", "echo"]) {
        await page.getByTestId(`mode-${mode}`).click();
        await page.getByTestId("start").click();
        await page.waitForFunction(
            (mode) =>
                window.__callDemoStats?.mode === mode &&
                window.__callDemoStats?.outputRms > 0.005 &&
                window.__callDemoLevels?.receive > 0.005 &&
                (mode !== "virtual" || window.__callDemoStats.nativeInputSamples > 20000),
            mode,
            { timeout: 20000 },
        );
        await page.waitForFunction(() => window.__callDemoRtc?.received > 0, null, { timeout: 5000 });
        const measured = await page.evaluate(() => ({
            stats: window.__callDemoStats,
            levels: window.__callDemoLevels,
            rtc: window.__callDemoRtc,
        }));
        results.push({ mode, ...measured });
        await page.screenshot({ path: `artifacts/demo-${mode}.png`, fullPage: true });
        await page.getByTestId("stop").click();
        await page.waitForFunction(
            async () => !(await fetch("/api/status").then((response) => response.json())).active,
        );
    }
    await page.getByTestId("mode-echo").click();
    await page.getByTestId("source-mic").click();
    await page.getByTestId("start").click();
    await page.waitForFunction(
        () =>
            window.__callDemoStats?.mode === "echo" &&
            window.__callDemoStats.inputRms > 0.001 &&
            window.__callDemoLevels?.receive > 0.001,
        null,
        { timeout: 15000 },
    );
    results.push({ fakeMicrophone: "getUserMedia → WebRTC → PCM echo → browser verified; no real microphone used" });
    await page.getByTestId("stop").click();
    await page.waitForFunction(() => window.__callDemoAudioState?.().localTracks?.every((state) => state === "ended"));
    results.push({ cleanup: "microphone tracks ended after Stop" });
    const status = await page.evaluate(async () => (await fetch("/api/status")).json());
    if (status.independent?.nativeEngine !== false) throw new Error("Backend must not use native Zalo engine");
    results.push({ engine: "independent", nativeEngine: false });
    await page.getByTestId("mode-zalo").click();
    if (await page.getByTestId("start").isEnabled())
        throw new Error("Unimplemented independent media must stay gated");
    results.push({ liveZalo: "media incomplete; correctly gated without starting a native helper" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "artifacts/demo-mobile.png", fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error("Mobile page overflows horizontally");
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    await fs.writeFile(
        "artifacts/browser-results.json",
        JSON.stringify({ testedAt: new Date().toISOString(), results, errors }, null, 2),
    );
    console.log(JSON.stringify({ success: true, results, errors }, null, 2));
} catch (error) {
    await page.screenshot({ path: "artifacts/demo-failure.png", fullPage: true });
    console.error("Browser test failed:", error.message);
    console.error(
        "Audio metrics:",
        await page.evaluate(() => ({
            stats: window.__callDemoStats,
            levels: window.__callDemoLevels,
            rtc: window.__callDemoRtc,
            state: window.__callDemoAudioState?.(),
        })),
    );
    console.error(await page.locator("body").innerText());
    throw error;
} finally {
    await browser.close();
}
