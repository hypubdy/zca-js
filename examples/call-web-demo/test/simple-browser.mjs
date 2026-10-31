import { chromium } from "playwright-core";
import fs from "node:fs/promises";

const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
});
const page = await browser.newPage({ viewport: { width: 1040, height: 900 }, locale: "vi-VN" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
    await page.goto(process.env.SIMPLE_DEMO_URL || "http://localhost:4317/simple", { waitUntil: "networkidle" });
    await page.getByTestId("gateway-state").getByText("Đã kết nối").waitFor();
    await page.locator(".account-card h1").waitFor();
    const accountHeading = await page.locator(".account-card h1").innerText();
    if (!["Liên kết Zalo để gọi", "Zalo đã liên kết"].includes(accountHeading))
        throw new Error(`Unexpected account state: ${accountHeading}`);
    await page.getByTestId("call-state").getByText("Sẵn sàng").waitFor();
    if (errors.length) throw new Error(errors.join("; "));

    await fs.mkdir("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/simple-call-demo.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error("Simple call demo overflows horizontally on mobile");
    console.log(JSON.stringify({ success: true, url: page.url(), errors }));
} finally {
    await browser.close();
}
