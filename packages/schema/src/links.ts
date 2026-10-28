// `BaseNode.link` / `TextStyle.link` hold "a url or page:<pageId>" (DOCUMENT_MODEL §3). The document stores any
// string, so every client that turns a link into something clickable (share / present pages, exports, the editor)
// must go through parseLink: it only lets through web, mail and phone URLs, never `javascript:`, `data:` & co.
import { isId } from "./ids";

export type ParsedLink = { kind: "page"; pageId: string } | { kind: "url"; href: string };

/** URL schemes a design link may open. */
export const SAFE_LINK_PROTOCOLS: readonly string[] = ["http:", "https:", "mailto:", "tel:"];

/**
 * Parses a design link. Returns the target page for `page:<id>`, a normalized absolute `href` for http(s), mailto
 * and tel URLs, and null for anything else (other schemes such as `javascript:` or `data:`, relative URLs, junk).
 * Uses the WHATWG URL parser, so obfuscations browsers accept (`JaVaScRiPt:`, tabs or newlines inside the scheme,
 * leading control characters) are recognized and rejected the same way a browser would read them.
 */
export function parseLink(link: unknown): ParsedLink | null {
  if (typeof link !== "string") return null;
  const page = /^page:(.+)$/.exec(link);
  if (page) return isId(page[1]) ? { kind: "page", pageId: page[1] as string } : null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!SAFE_LINK_PROTOCOLS.includes(url.protocol)) return null;
  return { kind: "url", href: url.href };
}

/** True when `parseLink` accepts the link. */
export function isSafeLink(link: unknown): boolean {
  return parseLink(link) !== null;
}
