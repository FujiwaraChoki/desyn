// Visual verification: full-page screenshots of every route at three viewports, dark and light,
// plus a scroll series of the home page. Requires a running server (pnpm build && pnpm start).
//
//   node scripts/screenshots.mjs [baseUrl=http://localhost:4102] [outDir=shots/review]
//
// Uses Playwright's cached Chromium (or CHROMIUM_PATH). GPU via ANGLE/GL so the WebGL sun renders.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = (process.argv[2] ?? "http://localhost:4102").replace(/\/$/, "");
const out = process.argv[3] ?? "shots/review";
mkdirSync(out, { recursive: true });

const defaultChrome = join(homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
const executablePath =
  process.env.CHROMIUM_PATH ?? (existsSync(defaultChrome) ? defaultChrome : "/usr/bin/chromium");

const ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/features/ai",
  "/features/templates",
  "/features/brand",
  "/features/workflows",
  "/features/collaboration",
  "/features/self-hosting",
  "/templates",
  "/download",
  "/changelog",
  "/about",
  "/security",
  "/contact",
  "/legal/terms",
  "/legal/privacy",
  "/legal/cookies",
  "/legal/license",
  "/legal/dpa",
  "/docs",
  "/this-page-does-not-exist",
];

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "390", width: 390, height: 844, mobile: true },
];

const slug = (p) => (p === "/" ? "home" : p.slice(1).replace(/\//g, "_"));

const browser = await chromium.launch({
  executablePath,
  args: ["--use-angle=gl", "--enable-unsafe-swiftshader"],
});
const problems = [];

async function settle(page) {
  // Walk the page so every in-view entrance animation runs, then return to the top.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.max(400, (await page.evaluate(() => innerHeight)) * 0.8);
  for (let y = 0; y < height; y += step) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(140);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
}

for (const theme of ["dark", "light"]) {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: Boolean(vp.mobile),
      hasTouch: Boolean(vp.mobile),
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("desyn-theme", t);
      } catch {}
    }, theme);
    const page = await context.newPage();
    let current = "/";
    page.on("pageerror", (e) =>
      problems.push(`${theme}/${vp.name} ${current} pageerror: ${e.message}`),
    );
    page.on("console", (m) => {
      // The not-found route answers 404 on purpose; the browser logs that as a console error.
      if (m.type() === "error" && !current.startsWith("/this-page")) {
        problems.push(`${theme}/${vp.name} ${current} console: ${m.text().slice(0, 200)}`);
      }
    });
    for (const route of ROUTES) {
      current = route;
      const res = await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      const expected = route.startsWith("/this-page") ? 404 : 200;
      if (res?.status() !== expected) problems.push(`${route} returned ${res?.status()}`);
      // Compare with the configured width: on emulated phones an overflow widens innerWidth itself.
      const overflow = await page.evaluate(
        (w) => document.documentElement.scrollWidth - w,
        vp.width,
      );
      if (overflow > 1)
        problems.push(`${theme}/${vp.name} ${route}: horizontal overflow ${overflow}px`);
      if (route === "/") {
        // The home page is long and scroll-driven: capture it as a series instead of one tall image.
        await page.waitForTimeout(3600);
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        let i = 0;
        for (let y = 0; y < total; y += vp.height * 0.92) {
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(900);
          await page.screenshot({
            path: join(out, `${theme}-${vp.name}-home-${String(i).padStart(2, "0")}.png`),
          });
          i++;
        }
        continue;
      }
      await settle(page);
      await page.screenshot({
        path: join(out, `${theme}-${vp.name}-${slug(route)}.png`),
        fullPage: true,
      });
    }
    await context.close();
  }
}

// Interactions: the mobile menu, the live demo after its autoplay, and reduced motion.
{
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await phone.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.click('button[aria-controls="mobile-menu"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, "interaction-390-menu.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector("#demo")?.scrollIntoView());
  await page.waitForTimeout(13000);
  await page.screenshot({ path: join(out, "interaction-390-demo.png") });
  await phone.close();

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const d = await desk.newPage();
  await d.goto(`${base}/`, { waitUntil: "networkidle" });
  await d.evaluate(() => {
    const el = document.querySelector("#demo");
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + 260);
  });
  await d.waitForTimeout(13500);
  await d.screenshot({ path: join(out, "interaction-1440-demo.png") });
  // Type a custom prompt and apply an edit by text.
  await d.click('button:has-text("New design")');
  await d.fill("#demo-prompt", "a poster for our harvest festival");
  await d.press("#demo-prompt", "Enter");
  await d.waitForTimeout(6500);
  await d.fill("#demo-prompt", "move the image to the right");
  await d.press("#demo-prompt", "Enter");
  await d.waitForTimeout(2800);
  await d.screenshot({ path: join(out, "interaction-1440-demo-custom.png") });
  await desk.close();

  const calm = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const c = await calm.newPage();
  await c.goto(`${base}/`, { waitUntil: "networkidle" });
  await c.waitForTimeout(2500);
  await c.screenshot({ path: join(out, "interaction-1440-reduced-motion.png") });
  await calm.close();
}

await browser.close();
if (problems.length) {
  console.log(`Problems (${problems.length}):\n${[...new Set(problems)].join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Saved screenshots to ${out}; no console errors, no horizontal overflow, all statuses as expected.`,
  );
}
