// End-to-end smoke test of a live Desyn deployment, through the pre-launch basic auth:
//   landing + template gallery, docs, sign-up (SES mailbox simulator) -> verification via the internal
//   admin/e2e:markEmailVerified -> sign-in -> onboarding -> new design from a template in the editor -> AI prompt
//   from the dashboard -> share page. Screenshots of every step go to --out.
//
//   node deploy/tests/prod-smoke.mjs --host hetzner --out /tmp/desyn-smoke [--skip-ai] [--headed]
//
// Basic-auth credentials are read from the server (/root/desyn-basic-auth.txt) over ssh and the test account's
// password is generated here; neither is printed. Needs playwright-core (apps/landing devDependency) and a
// Chromium (/usr/bin/chromium or PLAYWRIGHT_CHROMIUM).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const require = createRequire(join(repo, "apps/landing/package.json"));
const { chromium } = require("playwright-core");

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const host = opt("--host", "hetzner");
const out = opt("--out", "/tmp/desyn-smoke");
const skipAi = args.includes("--skip-ai");
mkdirSync(out, { recursive: true });

function env(file, name) {
  for (const line of readFileSync(join(repo, file), "utf8").split("\n")) {
    const m = new RegExp(`^${name}=(.*)$`).exec(line.trim());
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}
const SITE = env("deploy/env/public.env", "SITE_URL") ?? "https://desyn.app";
const APP = env("deploy/env/public.env", "APP_URL") ?? "https://app.desyn.app";
const DOCS = env("deploy/env/public.env", "DOCS_URL") ?? "https://docs.desyn.app";
const DEPLOYMENT = env("deploy/env/public.env", "CONVEX_DEPLOYMENT") ?? "prod:opulent-alpaca-530";

function basicAuth() {
  const raw = execFileSync("ssh", [host, "sudo cat /root/desyn-basic-auth.txt"], { encoding: "utf8" });
  const user = /user(?:name)?\s*[:=]\s*(\S+)/i.exec(raw)?.[1];
  const pass = /pass(?:word)?\s*[:=]\s*(\S+)/i.exec(raw)?.[1];
  if (!user || !pass) throw new Error("could not parse /root/desyn-basic-auth.txt");
  return { username: user, password: pass };
}

const results = [];
/** Polls the URL (client-side redirects abort the navigations waitForURL tracks). */
async function urlMatches(page, re, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(page.url())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${re} (at ${page.url()})`);
}
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e).split("\n")[0] });
    console.log(`FAIL  ${name}: ${String(e?.message ?? e).split("\n")[0]}`);
    throw e;
  }
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/bin/chromium",
  headless: !args.includes("--headed"),
});
const context = await browser.newContext({
  httpCredentials: basicAuth(),
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (err) => consoleErrors.push(`${page.url()} ${err}`));
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });

const tag = Date.now().toString(36);
const email = `success+e2e-${tag}@simulator.amazonses.com`;
const password = `${randomBytes(18).toString("base64url")}aA1!`;

try {
  await step("landing renders", async () => {
    await page.goto(SITE, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await shot("01-landing");
  });
  await step("template gallery lists the library", async () => {
    await page.goto(`${SITE}/templates`, { waitUntil: "networkidle" });
    await page.getByText(/\d+ templates/).first().waitFor();
    const count = Number((await page.getByText(/\d+ templates/).first().textContent())?.match(/\d+/)?.[0]);
    if (!(count >= 300)) throw new Error(`gallery shows ${count} templates`);
    await shot("02-templates");
  });
  await step("docs render", async () => {
    await page.goto(DOCS, { waitUntil: "networkidle" });
    await page.getByRole("heading").first().waitFor();
    await shot("03-docs");
  });
  await step("sign up", async () => {
    await page.goto(`${APP}/signup`, { waitUntil: "networkidle" });
    await page.getByLabel("Name").fill("Smoke Test");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/verify\?email=/, { timeout: 30_000 });
    await shot("04-verify");
  });
  await step("verify email (internal helper)", async () => {
    execFileSync(
      "npx",
      ["convex", "run", "admin/e2e:markEmailVerified", JSON.stringify({ email }), "--deployment", DEPLOYMENT.replace(/^prod:/, "")],
      { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
    );
  });
  if (!skipAi) {
    await step("give the test account Pro (internal helper)", async () => {
      execFileSync(
        "npx",
        ["convex", "run", "admin/e2e:setTestPlan", JSON.stringify({ email, plan: "pro" }), "--deployment", DEPLOYMENT.replace(/^prod:/, "")],
        { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
      );
    });
  }
  await step("sign in", async () => {
    await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await urlMatches(page, /app\.desyn\.app\/(onboarding)?(\?.*)?$/);
    await page.waitForLoadState("networkidle");
    await shot("05-signed-in");
  });
  await step("onboarding", async () => {
    if (!/\/onboarding/.test(page.url())) return;
    await page.getByRole("button", { name: "Social media" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Just me for now" }).click();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("button", { name: "Open Desyn" }).click();
    await urlMatches(page, /app\.desyn\.app\/?(\?.*)?$/);
    await page.waitForLoadState("networkidle");
    await shot("06-dashboard");
  });
  await step("open a template in the editor", async () => {
    await page.goto(`${APP}/templates`, { waitUntil: "networkidle" });
    const decline = page.getByRole("button", { name: "Decline" });
    if (await decline.isVisible().catch(() => false)) await decline.click();
    await shot("07-app-templates");
    // A free template (premium ones carry a PRO badge): open its preview, then use it.
    await page.getByRole("button", { name: /^Preview .*Instagram Post/ }).first().click();
    await page.waitForTimeout(1_500);
    await shot("07b-template-preview");
    await page.getByRole("button", { name: "Use template" }).click();
    await urlMatches(page, /\/design\//, 60_000);
    await page.locator("canvas").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(5_000);
    await shot("08-editor-template");
  });
  await step("double click edits text and adds text into a shape", async () => {
    // The real-estate post: headline at the upper left of the page, a plain beige band across the bottom half.
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(470, 290);
    await page.waitForTimeout(800);
    await page.keyboard.press("End");
    await page.keyboard.type(" Revival");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await shot("08b-text-edited");
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(430, 480);
    await page.waitForTimeout(800);
    await page.keyboard.type("Open house this Sunday");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1_200);
    await shot("08c-text-in-shape");
    // The shape now holds the text: one element that moves and resizes together.
    await page.keyboard.press("Escape");
    await page.mouse.click(430, 470);
    await page.waitForTimeout(500);
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await page.waitForTimeout(800);
    await shot("08d-container-moved");
    // Drag the right edge in: the text re-wraps inside the narrower shape.
    await page.mouse.move(852, 520);
    await page.mouse.down();
    await page.mouse.move(760, 520, { steps: 6 });
    await page.mouse.move(640, 520, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(1_200);
    await shot("08e-container-resized");
  });
  if (!skipAi) {
    await step("AI: the editor's dock edits the open design", async () => {
      const box = page.getByRole("textbox", { name: "Ask the AI" });
      await box.fill("Change the headline to 'Sunlit Victorian with a garden', make the price larger, and add a small 'Open house Sunday' badge near the top");
      await box.press("Enter");
      await page.waitForTimeout(5_000);
      await shot("09a-ai-running");
      // The agent works through several model calls; capture the canvas as it goes.
      await page.waitForTimeout(45_000);
      await shot("09b-ai-45s");
      await page.waitForTimeout(75_000);
      await shot("09c-ai-120s");
    });
  }
} finally {
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed; page errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  page error: ${e.slice(0, 300)}`);
  console.log(`test account: ${email} (screenshots in ${out})`);
  await browser.close();
}
