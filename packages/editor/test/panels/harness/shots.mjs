// Screenshots of every panel state (dark + light, desktop + phone) for visual review.
//
//   HARNESS_ASSETS=<dir with sunset.jpg, abstract.jpg, portrait.jpg> node test/panels/harness/shots.mjs <outDir>
//
// Starts the harness (Vite, port HARNESS_PORT or 4106), drives it with Playwright's Chromium, writes PNGs to
// <outDir>, reports console errors and exits non-zero when there are any. Not part of the shipped package.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../../ui/package.json", import.meta.url));
const { chromium } = require("playwright");

const outDir = process.argv[2] ?? fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const port = Number(process.env.HARNESS_PORT ?? 4106);
const base = `http://127.0.0.1:${port}/`;
const only = process.env.SHOTS_ONLY?.split(",") ?? null;

const vite = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../../../../ui/node_modules/vite/bin/vite.js", import.meta.url)),
    "--config",
    fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_PORT: String(port) } },
);
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d));
vite.stderr.on("data", (d) => (viteLog += d));

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`harness did not start\n${viteLog}`);
}

const errors = [];

async function open(browser, { theme, width, height, scale = 1, query = "" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${theme} ${width}] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[${theme} ${width}] ${e.message}`));
  await page.goto(`${base}?theme=${theme}${query}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__editor?.getState().engine.painted === true, null, {
    timeout: 30000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  return { context, page };
}

const ed = (page, fn, arg) => page.evaluate(fn, arg);
const byName = (n) => {
  const e = window.__editor;
  const node = Object.values(e.design.nodes).find((x) => x.name === n);
  if (node) e.select([node.id]);
  return !!node;
};

async function shot(page, name) {
  if (only && !only.some((o) => name.includes(o))) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${outDir}/${name}.png` });
}

async function rail(page, label) {
  await ed(page, (l) => window.__editor.setPanels({ left: l }), label);
  await page.waitForTimeout(500);
}

async function desktop(browser, theme) {
  const { context, page } = await open(browser, { theme, width: 1440, height: 900 });
  await shot(page, `${theme}-01-page-inspector`);
  for (const [id, label] of [
    ["design", "02-templates"],
    ["elements", "03-elements"],
    ["text", "04-text"],
    ["brand", "05-brand"],
    ["uploads", "06-uploads"],
    ["photos", "07-photos"],
    ["pages", "09-pages-panel"],
  ]) {
    await rail(page, id);
    if (id === "text") await page.waitForTimeout(1500); // font previews load
    await shot(page, `${theme}-${label}`);
  }
  // Layers with a nested selection.
  await rail(page, "layers");
  await ed(page, byName, "CTA label");
  await shot(page, `${theme}-08-layers`);
  // Inspector states.
  await ed(page, byName, "Headline");
  await shot(page, `${theme}-10-inspector-text`);
  await page.locator("[role=tabpanel][data-state=active]").evaluate((el) => el.scrollTo(0, 420));
  await shot(page, `${theme}-11-inspector-text-scrolled`);
  await ed(page, byName, "Sunset");
  await shot(page, `${theme}-12-inspector-image`);
  await page.locator("[role=tabpanel][data-state=active]").evaluate((el) => el.scrollTo(0, 560));
  await shot(page, `${theme}-13-inspector-image-filters`);
  await ed(page, byName, "CTA");
  await shot(page, `${theme}-14-inspector-frame`);
  await page.getByRole("tab", { name: "Effects" }).click();
  await shot(page, `${theme}-15-effects`);
  await page.getByRole("tab", { name: "Arrange" }).click();
  await shot(page, `${theme}-16-arrange`);
  await page.getByRole("tab", { name: "Animate" }).click();
  await shot(page, `${theme}-17-animate`);
  await page.getByRole("tab", { name: "Design" }).click();
  // Fill picker popover.
  await ed(page, byName, "Sun mark");
  await page
    .getByRole("button", { name: /^Fill 1/ })
    .first()
    .click();
  await shot(page, `${theme}-18-fill-picker`);
  await page.keyboard.press("Escape");
  // Font picker.
  await ed(page, byName, "Headline");
  await page.getByRole("button", { name: /^Font family/ }).click();
  await page.waitForTimeout(1200);
  await shot(page, `${theme}-19-font-picker`);
  await page.keyboard.press("Escape");
  // Dialogs.
  await ed(page, () =>
    window.__editor.openModal("page-resize", { pageId: window.__editor.getState().pageId }),
  );
  await shot(page, `${theme}-20-resize-dialog`);
  await page.keyboard.press("Escape");
  await rail(page, "elements");
  await page.getByRole("button", { name: "Column chart" }).click();
  await page.waitForTimeout(600);
  await shot(page, `${theme}-21-chart-data`);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(400);
  await shot(page, `${theme}-22-chart-inspector`);
  // Layers context menu.
  await rail(page, "layers");
  await page.getByRole("treeitem", { name: "Headline" }).click({ button: "right" });
  await shot(page, `${theme}-23-layers-context-menu`);
  await page.keyboard.press("Escape");
  // Page context menu in the strip.
  await page.getByRole("button", { name: /^Page 2/ }).click({ button: "right" });
  await shot(page, `${theme}-24-page-menu`);
  await page.keyboard.press("Escape");
  await context.close();

  // Stock photos without provider keys.
  const off = await open(browser, { theme, width: 1440, height: 900, query: "&stock=off" });
  await rail(off.page, "photos");
  await shot(off.page, `${theme}-25-photos-not-configured`);
  await off.context.close();
}

async function phone(browser, theme) {
  const { context, page } = await open(browser, { theme, width: 390, height: 844, scale: 2 });
  await shot(page, `${theme}-30-phone`);
  await ed(page, () => window.__editor.setPanels({ left: "elements" }));
  await page.getByRole("button", { name: "Panels" }).click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(500);
  await shot(page, `${theme}-31-phone-elements`);
  await page.keyboard.press("Escape");
  await ed(page, byName, "Headline");
  await page.getByRole("button", { name: "Inspector" }).click();
  await shot(page, `${theme}-32-phone-inspector`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) errors.push(`[${theme} 390] horizontal overflow`);
  await context.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    for (const theme of ["dark", "light"]) {
      await desktop(browser, theme);
      await phone(browser, theme);
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  vite.kill();
}
if (errors.length > 0) {
  console.error(`console errors (${errors.length}):\n${[...new Set(errors)].join("\n")}`);
  process.exit(1);
}
console.log(`screenshots in ${outDir}`);
