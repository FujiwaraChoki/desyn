// Screenshots of app routes at 1440 and 390 px in dark and light, for visual review.
// Usage: node scripts/screenshots.mjs <baseUrl> <outDir> [--state storage.json] route1 route2 ...
// Fails (exit 1) on console errors or horizontal overflow.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const base = args.shift() ?? "http://localhost:4100";
const out = args.shift() ?? "shots";
let state;
const routes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--state") state = args[++i];
  else routes.push(args[i]);
}
if (routes.length === 0) routes.push("/login");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
let failures = 0;
for (const theme of ["dark", "light"]) {
  for (const [label, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: label === "mobile" ? 2 : 1,
      colorScheme: theme,
      ...(state ? { storageState: state } : {}),
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("desyn-theme", JSON.stringify(t));
        localStorage.setItem(
          "desyn-consent",
          JSON.stringify({ v: 1, choice: "denied", at: Date.now() }),
        );
      } catch {}
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(String(err)));
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(1200);
      // Stay under the auth server's per-IP request budget (all runs share 127.0.0.1).
      await page.waitForTimeout(Number(process.env.SHOT_DELAY_MS ?? 1500));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      const name = `${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}-${label}-${theme}.png`;
      await page.screenshot({ path: join(out, name), fullPage: true });
      const status = [overflow ? "OVERFLOW" : "", errors.length ? `ERRORS(${errors.length})` : ""]
        .filter(Boolean)
        .join(" ");
      console.log(`${name} ${status}`);
      for (const e of errors) console.log(`  ${e.slice(0, 300)}`);
      if (overflow || errors.length) failures++;
      errors.length = 0;
    }
    await context.close();
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
