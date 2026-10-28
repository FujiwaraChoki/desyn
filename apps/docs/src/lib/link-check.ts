import { analyzePage } from "./content.ts";
import { FLAT_NAV, hrefForSlug } from "./nav.ts";
import type { DesynFileData } from "./remark-desyn.ts";

export interface LinkProblem {
  page: string;
  line: number | undefined;
  url: string;
  problem: string;
}

export interface LinkReport {
  pages: number;
  links: number;
  problems: LinkProblem[];
}

/** Routes served by the app that are not documentation pages. */
const STATIC_ROUTES = new Set(["/search-index.json", "/sitemap.xml", "/robots.txt", "/icon.svg"]);

function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

/**
 * Checks every link in the MDX sources: internal paths must be documentation pages, #fragments
 * must exist on the target page (headings or component anchors), external links must be valid
 * absolute https/mailto URLs. Generated blocks are expanded first, so their links count too.
 */
export async function checkContentLinks(): Promise<LinkReport> {
  const pages = await Promise.all(FLAT_NAV.map((item) => analyzePage(item.slug)));
  return findLinkProblems(pages);
}

/** The pure part of the check, over already analyzed pages. */
export function findLinkProblems(
  pages: { slug: string; data: Pick<DesynFileData, "anchors" | "links"> }[],
): LinkReport {
  const anchorsByPath = new Map(
    pages.map((p) => [hrefForSlug(p.slug), new Set(p.data.anchors)] as const),
  );
  const problems: LinkProblem[] = [];
  let links = 0;

  for (const page of pages) {
    const here = hrefForSlug(page.slug);
    for (const link of page.data.links) {
      links++;
      const report = (problem: string) =>
        problems.push({ page: here, line: link.line, url: link.url, problem });
      const url = link.url.trim();
      if (url === "") {
        report("empty link");
        continue;
      }
      if (url.startsWith("mailto:")) {
        if (!/^mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(url)) report("malformed mailto link");
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:") report("external links must use https");
        } catch {
          report("malformed external URL");
        }
        continue;
      }
      if (url.startsWith("#")) {
        if (!anchorsByPath.get(here)?.has(url.slice(1))) report(`no anchor "${url}" on this page`);
        continue;
      }
      if (!url.startsWith("/")) {
        report("internal links must be absolute paths starting with /");
        continue;
      }
      const [rawPath = "", hash] = url.split("#", 2);
      const path = normalizePath(rawPath);
      if (STATIC_ROUTES.has(path)) continue;
      const anchors = anchorsByPath.get(path);
      if (!anchors) {
        report(`no page at ${path}`);
        continue;
      }
      if (hash !== undefined && !anchors.has(hash)) report(`no anchor "#${hash}" on ${path}`);
    }
  }
  return { pages: pages.length, links, problems };
}

export function formatProblems(problems: LinkProblem[]): string {
  return problems
    .map((p) => `${p.page}${p.line ? `:${p.line}` : ""}  ${p.url}  — ${p.problem}`)
    .join("\n");
}
