/**
 * Icon and sticker search through the public Iconify API (no key). Icons come from the open-source sets the
 * app itself uses (Lucide, Tabler, Phosphor); stickers from colorful emoji sets. One search request, then
 * one JSON request per icon set for the bodies of every result (the per-icon SVG endpoint is rate limited),
 * cached for the session. Previews are data URLs (never markup injected into the page); inserted icons
 * become inline SVG layers, which the server sanitizes on commit (DOCUMENT_MODEL `SvgNode.markup`).
 */

export const ICONIFY_API = "https://api.iconify.design";
export const ICON_SETS = ["lucide", "tabler", "ph"] as const;
export const STICKER_SETS = ["fluent-emoji-flat", "noto", "twemoji"] as const;

export const ICON_SET_LABELS: Record<string, string> = {
  lucide: "Lucide",
  tabler: "Tabler",
  ph: "Phosphor",
  "fluent-emoji-flat": "Fluent Emoji",
  noto: "Noto Emoji",
  twemoji: "Twemoji",
};

const ID = /^[a-z0-9-]+:[a-z0-9-]+$/;

export function isIconId(id: string): boolean {
  return ID.test(id);
}

export interface IconData {
  body: string;
  width: number;
  height: number;
}

type FetchLike = typeof fetch;

export async function searchIcons(
  query: string,
  prefixes: readonly string[],
  options: { limit?: number; signal?: AbortSignal; fetch?: FetchLike } = {},
): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const url = new URL(`${ICONIFY_API}/search`);
  url.searchParams.set("query", q.slice(0, 100));
  url.searchParams.set("limit", String(Math.max(32, Math.min(256, options.limit ?? 96))));
  url.searchParams.set("prefixes", prefixes.join(","));
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(url.toString(), options.signal ? { signal: options.signal } : {});
  if (!res.ok) throw new Error(`Icon search failed (${res.status}).`);
  const body = (await res.json()) as { icons?: unknown };
  const icons = Array.isArray(body.icons) ? body.icons : [];
  return icons.filter((i): i is string => typeof i === "string" && isIconId(i));
}

const cache = new Map<string, IconData>();

interface IconSetJson {
  width?: number;
  height?: number;
  icons?: Record<string, { body?: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent?: string }>;
}

/** Bodies of icons (cached), fetched per icon set in batches. Unknown ids are left out. */
export async function loadIcons(
  ids: readonly string[],
  options: { signal?: AbortSignal; fetch?: FetchLike } = {},
): Promise<Map<string, IconData>> {
  const doFetch = options.fetch ?? fetch;
  const missing = new Map<string, string[]>();
  for (const id of ids) {
    if (!isIconId(id) || cache.has(id)) continue;
    const [prefix, name] = id.split(":") as [string, string];
    const list = missing.get(prefix) ?? [];
    list.push(name);
    missing.set(prefix, list);
  }
  const jobs: Promise<void>[] = [];
  for (const [prefix, names] of missing) {
    for (let i = 0; i < names.length; i += 64) {
      const batch = names.slice(i, i + 64);
      const url = new URL(`${ICONIFY_API}/${prefix}.json`);
      url.searchParams.set("icons", batch.join(","));
      jobs.push(
        doFetch(url.toString(), options.signal ? { signal: options.signal } : {}).then(
          async (res) => {
            if (!res.ok) throw new Error(`Icons could not be loaded (${res.status}).`);
            const set = (await res.json()) as IconSetJson;
            for (const name of batch) {
              const parent = set.aliases?.[name]?.parent;
              const icon = set.icons?.[name] ?? (parent ? set.icons?.[parent] : undefined);
              if (!icon?.body) continue;
              cache.set(`${prefix}:${name}`, {
                body: icon.body,
                width: icon.width ?? set.width ?? 16,
                height: icon.height ?? set.height ?? 16,
              });
            }
          },
        ),
      );
    }
  }
  await Promise.all(jobs);
  const out = new Map<string, IconData>();
  for (const id of ids) {
    const d = cache.get(id);
    if (d) out.set(id, d);
  }
  return out;
}

/** Standalone SVG markup for an icon; `color` replaces `currentColor` (monochrome sets). */
export function iconSvg(icon: IconData, color?: string): string {
  const body = color ? icon.body.replaceAll("currentColor", color) : icon.body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${icon.width}" height="${icon.height}" viewBox="0 0 ${icon.width} ${icon.height}">${body}</svg>`;
}

/** `data:` URL of an icon for `<img>` / CSS masks (previews). */
export function iconDataUrl(icon: IconData, color?: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(icon, color))}`;
}

/** Popular starting points shown before the user types. */
export const ICON_SUGGESTIONS = [
  "arrow",
  "star",
  "heart",
  "check",
  "sun",
  "phone",
  "mail",
  "map pin",
  "calendar",
  "camera",
  "shopping bag",
  "sparkles",
];

export const STICKER_SUGGESTIONS = [
  "party",
  "fire",
  "sparkles",
  "heart",
  "sun",
  "rocket",
  "coffee",
  "flower",
];
