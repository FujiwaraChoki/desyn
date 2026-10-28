// Screenshots of every AI dock state (playground on :4167 must be running:
//   npx vite --config test/ai/playground/vite.config.ts   from packages/editor).
// Usage: node test/ai/playground/shots.mjs [state ...]   Writes test/ai/shots/<state>-<theme>[-<width>].png and
// fails when a page logs a console error.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "shots");
mkdirSync(out, { recursive: true });
const BASE = process.env.AI_PLAYGROUND_URL ?? "http://127.0.0.1:4167";

const STATES = [
  "bar",
  "slash",
  "empty",
  "running",
  "question",
  "done",
  "failed",
  "free",
  "throttled",
  "browser",
  "media",
  "mockup",
  "workflow",
  "inspector",
  "inspector-text",
  "inpaint",
  "resize",
  "campaign",
  "variants",
  "localize",
  "bulk",
  "rail",
];
const wanted = process.argv.slice(2);
const runs = [];
for (const s of wanted.length ? wanted : STATES)
  runs.push({ state: s, theme: "dark", width: 1440, height: 900 });
if (!wanted.length) {
  for (const s of ["running", "done", "question", "inspector", "resize", "free"])
    runs.push({ state: s, theme: "light", width: 1440, height: 900 });
  runs.push({ state: "mobile", theme: "dark", width: 390, height: 844 });
  runs.push({ state: "done", theme: "dark", width: 390, height: 844 });
}

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const failures = [];
for (const r of runs) {
  const page = await browser.newPage({
    viewport: { width: r.width, height: r.height },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/?state=${r.state}&theme=${r.theme}`);
  await page.waitForFunction(() => window.__aiReady === true, null, { timeout: 30000 });
  await page.waitForTimeout(r.state === "done" ? 350 : 700);
  if (r.state === "inpaint") {
    const canvas = page.getByLabel("Mask brush area");
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3);
      await page.mouse.down();
      for (let k = 0; k <= 12; k++)
        await page.mouse.move(
          box.x + box.width * (0.35 + k * 0.02),
          box.y + box.height * (0.3 + Math.sin(k / 2) * 0.05),
        );
      await page.mouse.up();
    }
    await page
      .getByLabel("What should be there instead")
      .fill("a hot-air balloon drifting over the hills");
  }
  if (r.state === "bulk") {
    await page
      .locator("#bulk-csv")
      .fill(
        "headline,body,eyebrow\nGolden hour sessions,Live jazz on the rooftop.,LISBON · 21 JUNE\nBlue hour sessions,Ambient sets after dark.,PORTO · 28 JUNE\nNoon sessions,Acoustic brunch.,FARO · 5 JULY",
      );
    await page.waitForTimeout(500);
  }
  if (r.state === "slash") await page.getByLabel("Ask the AI").focus();
  const name = `${r.state}-${r.theme}${r.width < 800 ? `-${r.width}` : ""}.png`;
  await page.screenshot({ path: join(out, name) });
  if (errors.length) failures.push(`${name}: ${errors.join(" | ")}`);
  console.log(`${errors.length ? "✗" : "✓"} ${name}`);
  await page.close();
}
await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
