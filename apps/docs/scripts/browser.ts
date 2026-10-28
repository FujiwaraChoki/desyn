import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";

/**
 * Finds a Chromium binary for headless verification without downloading anything:
 * PLAYWRIGHT_CHROMIUM_PATH, then the newest cached Playwright headless shell, then system Chromium.
 */
export function findChromium(): string {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const dir of shells) {
      const bin = path.join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  for (const bin of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(bin)) return bin;
  }
  throw new Error("No Chromium found. Set PLAYWRIGHT_CHROMIUM_PATH.");
}

export function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: findChromium(), headless: true });
}

export function baseUrl(): string {
  return (process.env.DOCS_URL ?? "http://localhost:4103").replace(/\/+$/, "");
}
