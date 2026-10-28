// Lab performance check of a page (Lighthouse-style metrics via the browser's own APIs).
//
//   node scripts/perf.mjs [url=http://localhost:4102/] [profile=desktop|mobile]
//
// desktop: no throttling, 1440x900. mobile: 390x844, 4x CPU slowdown, "fast 4G" network.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:4102/";
const profile = process.argv[3] ?? "desktop";
const chrome = join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? (existsSync(chrome) ? chrome : "/usr/bin/chromium"),
  // Default (SwiftShader) GL: the ANGLE-GL path adds a one-off GPU-process start-up to the first
  // frame in headless runs, which real browsers with a warm GPU process do not pay.
  args: [],
});

const mobile = profile === "mobile";
const context = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  isMobile: mobile,
  hasTouch: mobile,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
if (mobile) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 60,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  });
}

let bytes = { js: 0, css: 0, font: 0, doc: 0, img: 0, other: 0 };
cdp.on("Network.loadingFinished", () => {});
page.on("response", async (r) => {
  const type = r.request().resourceType();
  const len = Number((await r.headerValue("content-length")) ?? 0);
  const key =
    type === "script"
      ? "js"
      : type === "stylesheet"
        ? "css"
        : type === "font"
          ? "font"
          : type === "document"
            ? "doc"
            : type === "image"
              ? "img"
              : "other";
  bytes = { ...bytes, [key]: bytes[key] + len };
});

await page.addInitScript(() => {
  window.__perf = { lcp: 0, lcpEl: "", cls: 0, longTasks: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__perf.lcp = e.startTime;
      window.__perf.lcpEl = e.element
        ? `${e.element.tagName}.${String(e.element.className).slice(0, 40)}`
        : e.url;
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__perf.longTasks += Math.max(0, e.duration - 50);
  }).observe({ type: "longtask", buffered: true });
});

// Warm the renderer once (a real browser is already running), then measure a cold-cache load.
await page.goto("data:text/html,<p>warm-up</p>");
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(5000);
const result = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  return {
    ttfb: Math.round(nav.responseStart),
    fcp: Math.round(fcp?.startTime ?? 0),
    lcp: Math.round(window.__perf.lcp),
    lcpElement: window.__perf.lcpEl,
    cls: Number(window.__perf.cls.toFixed(4)),
    totalBlockingTime: Math.round(window.__perf.longTasks),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd),
  };
});
console.log(
  JSON.stringify(
    {
      url,
      profile,
      ...result,
      transferKB: Object.fromEntries(
        Object.entries(bytes).map(([k, v]) => [k, Math.round(v / 1024)]),
      ),
    },
    null,
    2,
  ),
);
await browser.close();
