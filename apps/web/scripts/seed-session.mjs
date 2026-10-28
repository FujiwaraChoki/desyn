// Creates a verified, onboarded user on the running app (local Convex, MAIL_TRANSPORT=log), adds a
// few designs, a folder and a brand kit, and saves the browser session for screenshots.
// Usage: E2E_CONVEX_LOG=<convex dev log> node scripts/seed-session.mjs <baseUrl> <state.json>
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:4100";
const out = process.argv[3] ?? "state.json";
const log = process.env.E2E_CONVEX_LOG;
if (!log) throw new Error("E2E_CONVEX_LOG is required");
const email = `seed+${Date.now().toString(36)}@example.com`;

async function mailLink(pattern) {
  for (let i = 0; i < 60; i++) {
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("mail (log transport)") && l.includes(email));
    for (const line of lines.reverse()) {
      const hit = (line.match(/https?:\/\/[^\s"'\\]+/g) ?? []).find((u) => pattern.test(u));
      if (hit) return hit;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no mail link");
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(`${base}/signup`);
await page.getByLabel("Name").fill("Mira Okafor");
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password", { exact: true }).fill("Sunlit-Studio-2026");
await page.getByRole("button", { name: "Create account" }).click();
console.log("signed up");
await page.waitForURL(/\/verify/, { waitUntil: "commit" });
await page.goto(await mailLink(/verify-email/));
await page.waitForURL(/\/onboarding/, { waitUntil: "commit" });
await page.getByRole("button", { name: "Social media" }).click();
await page.getByRole("button", { name: "Continue" }).click();
await page.getByRole("button", { name: "Just me for now" }).click();
await page.getByRole("button", { name: "Skip for now" }).click();
await page.getByRole("button", { name: "Open Desyn" }).click();
await page.waitForURL(`${base}/`, { waitUntil: "commit" });
console.log("onboarded");

for (const name of ["Spring campaign", "Client pitches"]) {
  await page.getByRole("button", { name: "New folder" }).first().click();
  await page.getByLabel("Folder name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name }).first().waitFor();
}
for (const preset of ["Instagram post", "Presentation", "Poster", "YouTube thumbnail", "Story"]) {
  await page.goto(`${base}/`);
  await page
    .getByRole("button", { name: new RegExp(`^${preset} \\d`) })
    .first()
    .click();
  await page.waitForURL(/\/design\//, { waitUntil: "commit" });
  console.log("created", preset);
}
await page.goto(`${base}/brand`);
await page.getByRole("button", { name: "New brand kit" }).first().click();
await page.getByRole("textbox", { name: "Name" }).waitFor();
await context.storageState({ path: out });
console.log(`seeded ${email} -> ${out}`);
await browser.close();
