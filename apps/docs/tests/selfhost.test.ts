import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_VARS } from "../src/data/env.ts";
import { contentDir, repoPath } from "../src/lib/paths.ts";

// The self-hosting guides describe the stack that ships in deploy/compose and the variables the
// Convex functions really read. These tests fail when either side drifts.

function readRepo(relative: string): string {
  return readFileSync(repoPath(relative), "utf8");
}

function selfHostPages(): { name: string; text: string }[] {
  const dir = path.join(contentDir(), "self-hosting");
  const pages = readdirSync(dir)
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => ({ name: `self-hosting/${f}`, text: readFileSync(path.join(dir, f), "utf8") }));
  pages.push({
    name: "self-hosting.mdx",
    text: readFileSync(path.join(contentDir(), "self-hosting.mdx"), "utf8"),
  });
  return pages;
}

/** Top-level service names of a Compose file (two-space indented keys under `services:`). */
function composeServices(yaml: string): Set<string> {
  const body = yaml.slice(yaml.indexOf("\nservices:\n"));
  const end = body.search(/\n[a-z]+:\n/);
  const section = end > 0 ? body.slice(0, end + 1) : body;
  return new Set([...section.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1] ?? ""));
}

/** Flags of `docker compose` subcommands that take a separate value. */
const VALUE_FLAGS = new Set(["-f", "--file", "--profile", "-v", "--volume", "-e", "--env", "-p"]);

/**
 * Service names in one `docker compose …` command: the first positional argument of exec/run
 * (the rest is the command run inside), every positional of up/pull/logs/ps/build/restart.
 */
function commandServices(command: string): string[] {
  const words = command.trim().split(/\s+/);
  const out: string[] = [];
  let sub: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (VALUE_FLAGS.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith("-")) continue;
    if (!sub) {
      sub = word;
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
    out.push(word);
    if (sub === "exec" || sub === "run") break;
  }
  return ["exec", "run", "up", "pull", "logs", "ps", "build", "restart"].includes(sub ?? "")
    ? out
    : [];
}

/** Environment variable names read by Convex functions (`env.get/has/require`, `read`, `process.env`). */
function convexEnvReads(): Map<string, string> {
  const found = new Map<string, string>();
  const root = repoPath("convex");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, file);
    if (rel.startsWith("_generated") || rel.startsWith("tests") || /\.test\.ts$/.test(rel))
      continue;
    const source = readFileSync(file, "utf8");
    const patterns = [
      /\b(?:env\.(?:get|has|require)|read)\("([A-Z][A-Z0-9_]+)"\)/g,
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /process\.env\["([A-Z][A-Z0-9_]+)"\]/g,
    ];
    for (const re of patterns) {
      for (const m of source.matchAll(re)) if (m[1] && !found.has(m[1])) found.set(m[1], rel);
    }
  }
  return found;
}

describe("Docker Compose quickstart matches deploy/compose", () => {
  const stackFile = "deploy/compose/desyn.selfhost.yml";
  const stack = readRepo(stackFile);
  const stackEnv = readRepo("deploy/compose/.env.example");
  const convexEnv = readRepo("deploy/compose/convex.selfhost.env.example");
  const quickstart = readFileSync(
    path.join(contentDir(), "self-hosting/docker-compose.mdx"),
    "utf8",
  );

  it("uses the stack file and env templates that exist in the repository", () => {
    for (const file of [
      stackFile,
      "deploy/compose/.env.example",
      "deploy/compose/convex.selfhost.env.example",
    ]) {
      expect(existsSync(repoPath(file)), file).toBe(true);
      expect(quickstart, file).toContain(file);
    }
    expect(quickstart).toContain(`COMPOSE_FILE=${stackFile}`);
  });

  it("names only services that the stack defines", () => {
    const services = composeServices(stack);
    expect([...services]).toEqual(
      expect.arrayContaining(["web", "convex-backend", "convex-tools"]),
    );
    let checked = 0;
    for (const page of selfHostPages()) {
      for (const m of page.text.matchAll(/docker compose ([^\n`|#]+)/g)) {
        for (const name of commandServices(m[1] ?? "")) {
          checked++;
          expect(services.has(name), `${page.name}: docker compose ${m[1]} -> ${name}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("mentions only profiles the stack defines", () => {
    const profiles = new Set(
      [...stack.matchAll(/profiles: \[([a-z, ]+)\]/g)].flatMap((m) =>
        (m[1] ?? "").split(",").map((p) => p.trim()),
      ),
    );
    for (const page of selfHostPages()) {
      for (const m of page.text.matchAll(/--profile ([a-z]+)/g)) {
        expect(profiles.has(m[1] ?? ""), `${page.name}: profile ${m[1]}`).toBe(true);
      }
    }
  });

  it("documents DESYN_* stack variables that exist in .env.example or the stack file", () => {
    for (const page of selfHostPages()) {
      for (const m of page.text.matchAll(/\bDESYN_([A-Z_]+)\b/g)) {
        const name = `DESYN_${m[1]}`;
        if (name === "DESYN_EDITION") continue;
        const known = stackEnv.includes(`${name}=`) || stack.includes(`\${${name}`);
        expect(known, `${page.name}: ${name}`).toBe(true);
      }
    }
  });

  it("fills exactly the required secrets of the stack", () => {
    const required = [...stack.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1] ?? "");
    const unique = [...new Set(required)].sort();
    const loop = /for name in ([A-Z_ ]+); do/.exec(quickstart)?.[1]?.trim().split(/\s+/) ?? [];
    expect([...loop].sort()).toEqual(unique);
  });

  it("only sets backend variables the template defines", () => {
    for (const m of quickstart.matchAll(/^put ([A-Z_]+) /gm)) {
      expect(convexEnv, m[1]).toContain(`${m[1]}=`);
    }
  });

  it("does not reference the retired hand-written stack", () => {
    for (const page of selfHostPages()) {
      for (const stale of ["desyn_default", "desyn/convex:local", "8333", "storage/s3.json"]) {
        expect(page.text.includes(stale), `${page.name} mentions ${stale}`).toBe(false);
      }
    }
  });
});

describe("configuration reference covers the backend", () => {
  // Names the backend reads only as undocumented fallbacks; documenting them would suggest a
  // second way to configure the same thing. MAIL_FROM is described in the SES_FROM entry.
  const ALIASES: Record<string, string | null> = { MAIL_FROM: "SES_FROM", FAL_KEY: null };

  it("documents every environment variable the Convex functions read", () => {
    const documented = new Set(ENV_VARS.map((v) => v.name));
    const reads = convexEnvReads();
    expect(reads.size).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const [name, file] of reads) {
      if (documented.has(name) || name in ALIASES) continue;
      missing.push(`${name} (${file})`);
    }
    expect(missing).toEqual([]);
  });

  it("describes aliases in the entry of the variable they stand in for", () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      if (!target) continue;
      const entry = ENV_VARS.find((v) => v.name === target);
      expect(entry?.description, alias).toContain(alias);
    }
  });
});
