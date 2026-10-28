// Stock photo search: Unsplash (UNSPLASH_ACCESS_KEY) and Pexels (PEXELS_API_KEY), merged and normalized, with
// the attribution and download tracking each API requires.
import { AiError } from "../errors";
import type { StockPhoto, StockProvider, StockSearchOptions } from "../tools/types";
import { defaultFetch, type FetchLike, fetchJson } from "../util/async";
import { sniffMime } from "../util/bytes";

const UTM = "utm_source=desyn&utm_medium=referral";

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  color?: string;
  description?: string | null;
  alt_description?: string | null;
  urls: { raw: string; regular: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

export function createUnsplash(
  accessKey: string,
  options: { fetch?: FetchLike } = {},
): StockProvider {
  const doFetch = options.fetch ?? defaultFetch();
  const headers = { authorization: `Client-ID ${accessKey}`, "accept-version": "v1" };
  return {
    async search(o: StockSearchOptions) {
      const url = new URL("https://api.unsplash.com/search/photos");
      url.searchParams.set("query", o.query);
      url.searchParams.set("per_page", String(Math.min(30, o.count ?? 12)));
      url.searchParams.set("content_filter", "high");
      if (o.orientation)
        url.searchParams.set(
          "orientation",
          o.orientation === "square" ? "squarish" : o.orientation,
        );
      if (o.color) url.searchParams.set("color", o.color);
      const body = await fetchJson<{ results: UnsplashPhoto[] }>(url.toString(), {
        fetch: doFetch,
        headers,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return body.results.map(
        (p): StockPhoto => ({
          id: `unsplash:${p.id}`,
          provider: "unsplash",
          description: p.alt_description ?? p.description ?? "",
          width: p.width,
          height: p.height,
          thumbUrl: p.urls.small,
          url: `${p.urls.raw}${p.urls.raw.includes("?") ? "&" : "?"}w=2400&q=85&fm=jpg&fit=max`,
          ...(p.color ? { color: p.color } : {}),
          author: p.user.name,
          authorUrl: `${p.user.links.html}?${UTM}`,
          sourceUrl: `${p.links.html}?${UTM}`,
          license: "Unsplash License",
          downloadLocation: p.links.download_location,
        }),
      );
    },
    async download(photo, signal) {
      // Unsplash API guidelines: trigger the download endpoint whenever a photo is used.
      if (photo.downloadLocation) {
        await doFetch(photo.downloadLocation, { headers, ...(signal ? { signal } : {}) }).catch(
          () => undefined,
        );
      }
      return downloadBytes(doFetch, photo.url, signal);
    },
  };
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  alt?: string;
  avg_color?: string;
  photographer: string;
  photographer_url: string;
  src: { original: string; large2x: string; medium: string };
}

export function createPexels(apiKey: string, options: { fetch?: FetchLike } = {}): StockProvider {
  const doFetch = options.fetch ?? defaultFetch();
  const headers = { authorization: apiKey };
  return {
    async search(o: StockSearchOptions) {
      const url = new URL("https://api.pexels.com/v1/search");
      url.searchParams.set("query", o.query);
      url.searchParams.set("per_page", String(Math.min(40, o.count ?? 12)));
      if (o.orientation) url.searchParams.set("orientation", o.orientation);
      if (o.color) url.searchParams.set("color", o.color.replace("#", ""));
      const body = await fetchJson<{ photos: PexelsPhoto[] }>(url.toString(), {
        fetch: doFetch,
        headers,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return body.photos.map(
        (p): StockPhoto => ({
          id: `pexels:${p.id}`,
          provider: "pexels",
          description: p.alt ?? "",
          width: p.width,
          height: p.height,
          thumbUrl: p.src.medium,
          url: p.src.large2x,
          ...(p.avg_color ? { color: p.avg_color.toLowerCase() } : {}),
          author: p.photographer,
          authorUrl: p.photographer_url,
          sourceUrl: p.url,
          license: "Pexels License",
        }),
      );
    },
    download(photo, signal) {
      return downloadBytes(doFetch, photo.url, signal);
    },
  };
}

async function downloadBytes(doFetch: FetchLike, url: string, signal?: AbortSignal) {
  const res = await doFetch(url, signal ? { signal } : {});
  if (!res.ok)
    throw new AiError("provider-error", `Downloading the stock photo failed (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytes,
    mime: sniffMime(bytes) ?? res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
  };
}

/** Queries every configured source and interleaves the results (Unsplash first). */
export function combineStock(providers: StockProvider[]): StockProvider {
  const byPrefix = new Map<string, StockProvider>();
  return {
    async search(o) {
      const settled = await Promise.allSettled(
        providers.map(async (p) => {
          const results = await p.search(o);
          for (const r of results) byPrefix.set(r.provider, p);
          return results;
        }),
      );
      const lists = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (lists.length === 0 && settled.length > 0) {
        const first = settled.find((s) => s.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        throw first?.reason ?? new AiError("provider-error", "Stock search failed.");
      }
      const out: StockPhoto[] = [];
      for (let i = 0; out.length < (o.count ?? 12) && lists.some((l) => i < l.length); i++) {
        for (const l of lists)
          if (l[i] && out.length < (o.count ?? 12)) out.push(l[i] as StockPhoto);
      }
      return out;
    },
    download(photo, signal) {
      const p = byPrefix.get(photo.provider) ?? providers[0];
      if (!p) throw new AiError("provider-not-configured", "No stock photo source is configured.");
      return p.download(photo, signal);
    },
  };
}

/** Stock provider from env names `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY`; undefined when neither is set. */
export function stockFromEnv(
  env: Record<string, string | undefined>,
  options: { fetch?: FetchLike } = {},
): StockProvider | undefined {
  const list: StockProvider[] = [];
  if (env.UNSPLASH_ACCESS_KEY) list.push(createUnsplash(env.UNSPLASH_ACCESS_KEY, options));
  if (env.PEXELS_API_KEY) list.push(createPexels(env.PEXELS_API_KEY, options));
  return list.length > 0 ? combineStock(list) : undefined;
}
