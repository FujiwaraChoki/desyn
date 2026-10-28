import { baseUrl } from "./browser.ts";

/**
 * Crawls a running docs server (DOCS_URL, default http://localhost:4103) starting from the
 * sitemap: every page must return 200, and every same-site link and #fragment in the rendered
 * HTML — including header, sidebar, footer and generated content — must resolve.
 */
const origin = baseUrl();
const base = new URL(origin);
const basePath = base.pathname.replace(/\/+$/, "");

const pages = new Map<string, string>();

async function fetchPage(path: string): Promise<string | null> {
  if (pages.has(path)) return pages.get(path) ?? null;
  const res = await fetch(`${base.origin}${path}`, { redirect: "manual" });
  if (res.status !== 200) return null;
  const html = await res.text();
  pages.set(path, html);
  return html;
}

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) =>
    (m[1] ?? "").replace(/&amp;/g, "&"),
  );
}

const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
const start = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (m) => new URL(m[1] ?? "").pathname,
);
if (start.length === 0) throw new Error("sitemap.xml lists no pages");

const problems: string[] = [];
let checked = 0;
for (const path of start) {
  // The sitemap carries the canonical origin; crawl the same paths on the server under test.
  const html = await fetchPage(path);
  if (html === null) {
    problems.push(`${path}: page did not return 200`);
    continue;
  }
  const own = ids(html);
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? "");
  const duplicates = [...new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))];
  if (duplicates.length) problems.push(`${path}: duplicate ids ${duplicates.join(", ")}`);
  for (const href of hrefs(html)) {
    checked++;
    if (href.startsWith("#")) {
      if (href.length > 1 && !own.has(decodeURIComponent(href.slice(1))))
        problems.push(`${path}: missing anchor ${href}`);
      continue;
    }
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const [target = "", hash] = href.split("#", 2);
    if (basePath && !target.startsWith(basePath)) {
      problems.push(`${path}: link ${href} is outside the base path ${basePath}`);
      continue;
    }
    const targetHtml = await fetchPage(target);
    if (targetHtml === null) {
      problems.push(`${path}: ${href} does not return 200`);
      continue;
    }
    if (hash && !ids(targetHtml).has(decodeURIComponent(hash)))
      problems.push(`${path}: ${href} has no matching anchor`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(
    `\n${problems.length} problem(s); ${checked} links on ${start.length} pages checked.`,
  );
  process.exit(1);
}
console.log(
  `Crawled ${start.length} pages and ${pages.size} documents; all ${checked} links and anchors resolve.`,
);
