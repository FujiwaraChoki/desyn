// Quick single-page screenshot helper for iteration: node scripts/shot.mjs <path> <w> <h> <out> [theme] [waitMs] [scrollY]

import { homedir } from "node:os";
import { chromium } from "playwright-core";

const [
  path = "/",
  w = "1440",
  h = "900",
  out = "shots/quick.png",
  theme = "dark",
  wait = "3800",
  scrollY = "0",
] = process.argv.slice(2);
const exe = `${homedir()}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=gl"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
await page.addInitScript((t) => {
  try {
    localStorage.setItem("desyn-theme", t);
  } catch {}
}, theme);
page.on("console", (m) => {
  if (m.type() === "error") console.log("console:", m.text());
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:4102${path}`, { waitUntil: "networkidle" });
if (+scrollY) await page.evaluate((y) => window.scrollTo(0, y), +scrollY);
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
