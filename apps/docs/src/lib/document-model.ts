import { readFileSync } from "node:fs";
import { repoPath } from "./paths.ts";

/**
 * Reads docs/DOCUMENT_MODEL.md (the frozen contract) so the developer pages render the
 * contract itself instead of a copy that could drift.
 */
export function readDocumentModel(): string {
  return readFileSync(repoPath("docs/DOCUMENT_MODEL.md"), "utf8");
}

export interface ModelSection {
  /** Section number as written in the heading ("3"), or the full title for unnumbered ones. */
  key: string;
  title: string;
  /** Markdown body without the `## ` heading line. */
  body: string;
}

/** Split the contract into its `## ` sections. */
export function splitSections(markdown: string): ModelSection[] {
  const sections: ModelSection[] = [];
  const lines = markdown.split("\n");
  let current: { key: string; title: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const match = !inFence ? /^## (.+)$/.exec(line) : null;
    if (match?.[1]) {
      if (current) sections.push(finish(current));
      const title = match[1].trim();
      const numbered = /^(\d+)\.\s+(.*)$/.exec(title);
      current = numbered?.[1]
        ? { key: numbered[1], title: numbered[2] ?? title, lines: [] }
        : { key: title, title, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) sections.push(finish(current));
  return sections;
}

function finish(section: { key: string; title: string; lines: string[] }): ModelSection {
  return { key: section.key, title: section.title, body: section.lines.join("\n").trim() };
}

export function getSection(markdown: string, key: string): ModelSection {
  const found = splitSections(markdown).find((s) => s.key === key || s.title === key);
  if (!found) throw new Error(`DOCUMENT_MODEL.md has no section "${key}"`);
  return found;
}

/**
 * The body of a `### <title…>` subsection (heading excluded), up to the next `##`/`###` heading.
 * Matches when the heading text starts with `title`.
 */
export function getSubsection(body: string, title: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`### ${title}`));
  if (start < 0) throw new Error(`DOCUMENT_MODEL.md has no subsection "${title}"`);
  const out: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && /^#{2,3} /.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Collect the bodies of all ```ts fences in a markdown string. */
export function tsBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```ts\n([\s\S]*?)```/g;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    if (m[1] !== undefined) blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Extract top-level `type X` / `interface X` declarations by name from the contract's TS blocks.
 * A declaration starts at column 0 and runs until the next column-0 line that is not a
 * continuation (`|`, `}`), or a blank line. Throws if any name is missing so a contract change
 * that renames a type fails the docs build instead of silently dropping it.
 */
export function extractDeclarations(markdown: string, names: string[]): string {
  const lines = tsBlocks(markdown).join("\n").split("\n");
  const out: string[] = [];
  for (const name of names) {
    const start = lines.findIndex((line) =>
      new RegExp(`^(export\\s+)?(type|interface)\\s+${escapeRe(name)}\\b`).test(line),
    );
    if (start < 0) throw new Error(`DOCUMENT_MODEL.md declares no type named "${name}"`);
    const decl: string[] = [lines[start] ?? ""];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "") break;
      if (/^\S/.test(line) && !/^[|}]/.test(line)) break;
      decl.push(line);
    }
    out.push(decl.join("\n").replace(/\s+$/, ""));
  }
  return out.join("\n\n");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
