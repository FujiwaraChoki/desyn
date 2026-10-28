/**
 * Captures playground screenshots with headless Chromium for visual review.
 * Usage: start the playground (`pnpm playground`), then `pnpm screenshots [baseUrl]`.
 * Writes PNGs to playground/screenshots/ and fails on console errors.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4101/";
const outDir = fileURLToPath(new URL("./screenshots/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const themes = ["dark", "light"] as const;
const widths = [1440, 390] as const;
const errors: string[] = [];

async function open(page: Page, theme: string) {
  await page.addInitScript((t) => {
    localStorage.setItem("desyn-theme", JSON.stringify(t));
    localStorage.removeItem("desyn-panels:playground-editor");
  }, theme);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
try {
  for (const theme of themes) {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        deviceScaleFactor: width === 390 ? 2 : 1,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`[${theme} ${width}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => errors.push(`[${theme} ${width}] ${err.message}`));
      await open(page, theme);
      await page.screenshot({ path: `${outDir}/full-${theme}-${width}.png`, fullPage: true });
      await page.screenshot({ path: `${outDir}/top-${theme}-${width}.png` });

      if (width === 1440) {
        // Editor close-up.
        const editor = page.locator("#editor");
        await editor.evaluate((el) =>
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64),
        );
        await page.screenshot({ path: `${outDir}/editor-${theme}.png` });

        // Paint picker popover from the inspector.
        await page.getByRole("button", { name: /^Background fill/ }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${outDir}/paint-popover-${theme}.png` });
        await page.keyboard.press("Escape");

        // Font picker popover.
        await page.getByRole("button", { name: /^Font family/ }).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${outDir}/font-popover-${theme}.png` });
        await page.keyboard.press("Escape");

        // Dropdown menu inside the overlays showcase (first panel).
        const overlays = page.locator("#overlays");
        await overlays.scrollIntoViewIfNeeded();
        await overlays.getByRole("button", { name: "More actions" }).first().click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${outDir}/menu-${theme}.png` });
        await page.keyboard.press("Escape");

        // Dialog.
        await overlays.getByRole("button", { name: "Export…" }).first().click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${outDir}/dialog-${theme}.png` });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);

        // Command palette.
        await overlays
          .getByRole("button", { name: /Command palette/ })
          .first()
          .click();
        await page.waitForTimeout(400);
        await page.keyboard.type("ex");
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${outDir}/palette-${theme}.png` });
        await page.keyboard.press("Escape");

        // Element screenshots: unstick the header so it doesn't cover section titles.
        await page.addStyleTag({
          content: "body > div > div > header { position: static !important; }",
        });
        for (const id of [
          "actions",
          "forms",
          "structure",
          "feedback",
          "pickers",
          "data",
          "brand",
        ]) {
          const section = page.locator(`#${id}`);
          await section.scrollIntoViewIfNeeded();
          await section.screenshot({ path: `${outDir}/section-${id}-${theme}.png` });
        }
      } else {
        const editor = page.locator("#editor");
        await editor.scrollIntoViewIfNeeded();
        await editor.screenshot({ path: `${outDir}/editor-${theme}-mobile.png` });
        await page.getByRole("button", { name: "Open inspector" }).click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${outDir}/inspector-sheet-${theme}-mobile.png` });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (errors.length) {
  console.error(`Console errors:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`Screenshots written to ${outDir}`);
