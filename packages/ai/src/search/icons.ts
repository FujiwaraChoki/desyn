// Icon search through the public Iconify API (Lucide, Tabler and Phosphor by default, matching the editor's icon
// panel). No key is needed; results are sanitized SVG.
import { AiError } from "../errors";
import { sanitizeSvg } from "../media/svg";
import type { IconProvider, IconResult } from "../tools/types";
import { defaultFetch, type FetchLike, fetchJson } from "../util/async";

export const DEFAULT_ICON_SETS = ["lucide", "tabler", "ph"];

export function createIconify(options: { fetch?: FetchLike; baseUrl?: string } = {}): IconProvider {
  const doFetch = options.fetch ?? defaultFetch();
  const base = (options.baseUrl ?? "https://api.iconify.design").replace(/\/+$/, "");
  return {
    async search(query, o = {}) {
      const url = new URL(`${base}/search`);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(Math.max(32, Math.min(999, o.limit ?? 32))));
      url.searchParams.set("prefixes", (o.prefixes ?? DEFAULT_ICON_SETS).join(","));
      const body = await fetchJson<{ icons?: string[] }>(url.toString(), {
        fetch: doFetch,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return (body.icons ?? []).slice(0, o.limit ?? 32).map((id): IconResult => {
        const [collection = "", name = ""] = id.split(":");
        return { id, collection, name };
      });
    },
    async svg(id, o = {}) {
      const [prefix, name] = id.split(":");
      if (!prefix || !name || !/^[a-z0-9-]+$/.test(prefix) || !/^[a-z0-9-]+$/.test(name)) {
        throw new AiError("invalid-input", `"${id}" is not an icon id like "lucide:sun".`);
      }
      const url = new URL(`${base}/${prefix}/${name}.svg`);
      if (o.color) url.searchParams.set("color", o.color);
      const res = await doFetch(url.toString(), o.signal ? { signal: o.signal } : {});
      if (!res.ok) throw new AiError("not-found", `Icon "${id}" was not found.`);
      const text = await res.text();
      return sanitizeSvg(text).svg;
    },
  };
}
