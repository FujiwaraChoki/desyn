// Loads the canvas harness and takes a screenshot (quick visual check). Usage: node test/canvas/perf/smoke.mjs [query]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const query = process.argv[2] ?? "";
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`http://127.0.0.1:4108/${query}`);
await page.waitForFunction(
  () => window.__canvas?.editor?.getState().engine.painted === true,
  null,
  { timeout: 60000 },
);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}smoke.png` });
console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
