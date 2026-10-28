import { mkdirSync } from "node:fs";
import path from "node:path";
import { baseUrl, launch } from "./browser.ts";

/**
 * Captures pages in desktop + mobile and dark + light for visual review.
 * Usage: node scripts/screenshots.ts [outDir] [path ...]   (server must be running, see DOCS_URL)
 */
const DEFAULT_PAGES = [
  "/",
  "/quickstart",
  "/editor/keyboard-shortcuts",
  "/self-hosting/configuration",
  "/developers/api/designs",
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];
const THEMES = ["dark", "light"] as const;

const [outArg, ...pageArgs] = process.argv.slice(2);
const outDir = path.resolve(outArg ?? "screenshots");
const pages = pageArgs.length ? pageArgs : DEFAULT_PAGES;
mkdirSync(outDir, { recursive: true });

const browser = await launch();
try {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.name === "mobile" ? 2 : 1,
        colorScheme: theme,
      });
      await context.addInitScript((t) => localStorage.setItem("desyn-theme", t), theme);
      const page = await context.newPage();
      for (const p of pages) {
        await page.goto(`${baseUrl()}${p}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const name = `${p === "/" ? "home" : p.slice(1).replace(/\//g, "_")}-${vp.name}-${theme}.png`;
        await page.screenshot({ path: path.join(outDir, name), fullPage: false });
        console.log(name);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
