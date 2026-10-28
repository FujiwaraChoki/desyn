/**
 * Embed snippets for a view link. The iframe points at the share page with `embed=1` (chrome-less view in
 * the web app); the fallback link inside it keeps the snippet useful where iframes are blocked.
 */

export interface EmbedOptions {
  /** Share link URL (`https://app.desyn.app/share/<token>`). */
  url: string;
  title: string;
  /** Fixed size in CSS px, or responsive (fills the container width, keeps the aspect ratio). */
  size: { mode: "responsive"; aspect: number } | { mode: "fixed"; width: number; height: number };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** URL of the embeddable view (adds `embed=1`, keeps other parameters). */
export function embedUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("embed", "1");
    return u.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}embed=1`;
  }
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** The HTML snippet to paste into a site. */
export function buildEmbedCode(options: EmbedOptions): string {
  const src = escapeHtml(embedUrl(options.url));
  const title = escapeHtml(options.title.trim() || "Desyn design");
  const iframeAttrs = `src="${src}" title="${title}" loading="lazy" allow="fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"`;
  if (options.size.mode === "fixed") {
    const w = Math.max(1, Math.round(options.size.width));
    const h = Math.max(1, Math.round(options.size.height));
    return `<iframe ${iframeAttrs} width="${w}" height="${h}" style="border:0;border-radius:12px;max-width:100%"></iframe>`;
  }
  const aspect =
    options.size.aspect > 0 && Number.isFinite(options.size.aspect) ? options.size.aspect : 16 / 9;
  const pad = round(100 / aspect, 4);
  return [
    `<div style="position:relative;width:100%;height:0;padding-top:${pad}%;overflow:hidden;border-radius:12px">`,
    `  <iframe ${iframeAttrs} style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>`,
    "</div>",
    `<p style="margin:6px 0 0;font:12px system-ui,sans-serif"><a href="${escapeHtml(options.url)}" target="_blank" rel="noopener">${title}</a> · made with Desyn</p>`,
  ].join("\n");
}

/** Expiry presets of the link dialog (ms from now; null = never). */
export const EXPIRY_PRESETS: { value: string; label: string; ms: number | null }[] = [
  { value: "never", label: "Never expires", ms: null },
  { value: "1d", label: "Expires in 1 day", ms: 24 * 3_600_000 },
  { value: "7d", label: "Expires in 7 days", ms: 7 * 24 * 3_600_000 },
  { value: "30d", label: "Expires in 30 days", ms: 30 * 24 * 3_600_000 },
];

/** Parses an e-mail list typed or pasted into the invite field (commas, spaces, semicolons, new lines). */
export function parseEmails(input: string): { valid: string[]; invalid: string[] } {
  const parts = input
    .split(/[\s,;]+/)
    .map((p) => p.trim().replace(/^<|>$/g, ""))
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const p of parts) {
    const e = p.toLowerCase();
    if (re.test(e) && e.length <= 254) {
      if (!valid.includes(e)) valid.push(e);
    } else if (!invalid.includes(p)) invalid.push(p);
  }
  return { valid, invalid };
}
