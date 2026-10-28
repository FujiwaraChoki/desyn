import { existsSync } from "node:fs";
import path from "node:path";

let cachedRoot: string | undefined;

/**
 * Absolute path of the monorepo root. Found by walking up from the working directory
 * (next build, vitest and the scripts all run inside apps/docs or the repo root), because
 * bundled server code cannot rely on `import.meta.url` pointing at the source tree.
 */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(/* turbopackIgnore: true */ dir, "pnpm-workspace.yaml"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`Could not find the repository root above ${process.cwd()}`);
    dir = parent;
  }
}

export function repoPath(relative: string): string {
  // Only content files are read; they are traced explicitly via outputFileTracingIncludes.
  return path.join(/* turbopackIgnore: true */ repoRoot(), relative);
}

/** Absolute path of the docs app (apps/docs). */
export function appRoot(): string {
  return repoPath("apps/docs");
}

export function contentDir(): string {
  return path.join(/* turbopackIgnore: true */ appRoot(), "content");
}
