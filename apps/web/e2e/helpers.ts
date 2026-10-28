import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

/** A unique address per run so sign-up never collides with earlier runs. */
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
}

/**
 * The newest link for `email` written by the log mail transport (`mail (log transport)` lines in
 * the Convex dev output captured at E2E_CONVEX_LOG). Polls because mail is sent by a scheduled action.
 */
export async function mailLink(email: string, path: RegExp, timeoutMs = 30_000): Promise<string> {
  const file = process.env.E2E_CONVEX_LOG;
  if (!file)
    throw new Error("Set E2E_CONVEX_LOG to the file capturing `convex dev --tail-logs always`.");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = readFileSync(file, "utf8");
    const lines = text
      .split("\n")
      .filter((l) => l.includes("mail (log transport)") && l.includes(email));
    for (const line of lines.reverse()) {
      const urls = line.match(/https?:\/\/[^\s"'\\]+/g) ?? [];
      const hit = urls.find((u) => path.test(u));
      if (hit) return hit.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No mail link matching ${path} for ${email} within ${timeoutMs} ms`);
}

/** Collects console errors so a test can assert the page stayed clean. */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

export async function signUpAndVerify(
  page: Page,
  opts: { name: string; email: string; password: string },
) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(opts.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify\?email=/);
  await expect(page.getByRole("heading", { name: /check your inbox/i })).toBeVisible();
  const link = await mailLink(opts.email, /\/api\/auth\/verify-email\?/);
  await page.goto(link);
}

export async function completeOnboarding(page: Page) {
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Social media" }).click();
  await page.getByRole("button", { name: "Presentations" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: /design together/i })).toBeVisible();
  await page.getByRole("button", { name: "Just me for now" }).click();
  await expect(page.getByRole("heading", { name: /your brand, remembered/i })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: /you're ready/i })).toBeVisible();
  await page.getByRole("button", { name: "Open Desyn" }).click();
  await expect(page).toHaveURL(/\/$/);
}
