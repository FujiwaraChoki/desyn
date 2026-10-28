import { baseUrl, launch } from "./browser.ts";

/**
 * End-to-end check of search in a real browser against a running server: open the dialog with
 * the keyboard shortcut and the header button, query, read results, and navigate with Enter.
 */
interface Case {
  query: string;
  /** Path (and optional #hash) the top result must point to. */
  expect: string;
}

const CASES: Case[] = [
  { query: "S3_ENDPOINT", expect: "/self-hosting/configuration" },
  { query: "ollama origins", expect: "/ai/local-models" },
  { query: "crop marks", expect: "/editor/export" },
  { query: "commit a transaction", expect: "/developers/api/designs#commit-a-transaction" },
  { query: "keyboard shortcuts", expect: "/editor/keyboard-shortcuts" },
  { query: "brand kit", expect: "/concepts/brand-kits" },
];

const origin = baseUrl();
// Works for a /docs base-path build too: compare paths relative to the base path.
const basePath = new URL(origin).pathname.replace(/\/+$/, "");
const browser = await launch();
const failures: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });

  for (const [i, c] of CASES.entries()) {
    // Alternate between the keyboard shortcut and the header button.
    if (i % 2 === 0) await page.keyboard.press("Control+k");
    else await page.getByRole("button", { name: "Search documentation" }).click();
    const input = page.getByRole("combobox");
    await input.waitFor({ state: "visible" });
    await input.fill(c.query);
    const top = page.locator('[role="option"]').first();
    await top.waitFor({ state: "visible", timeout: 10_000 });
    const title = (await top.locator(".hit-title").textContent())?.trim();
    const before = page.url();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.href !== before, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    const url = new URL(page.url());
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || "/"
      : url.pathname;
    const got = path + url.hash;
    const ok = c.expect.includes("#") ? got === c.expect : path === c.expect;
    console.log(`${ok ? "ok  " : "FAIL"} "${c.query}" → ${got} (top hit: ${title})`);
    if (!ok) failures.push(`"${c.query}": expected ${c.expect}, got ${got}`);
  }

  // No results state.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("zzqxjv");
  await page.getByText(/No results for/).waitFor({ timeout: 5_000 });
  console.log('ok   "zzqxjv" → empty state');
  await page.keyboard.press("Escape");
  if (await page.getByRole("combobox").isVisible())
    failures.push("Escape did not close the dialog");
  else console.log("ok   Escape closes the dialog");
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nSearch works end to end.");
