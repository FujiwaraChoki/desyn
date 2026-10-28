import { listModels } from "@desyn/ai";

/*
 * The public OpenRouter and fal model catalogs for the AI settings page. Fetched server-side (the
 * catalogs do not allow browser CORS) and cached by @desyn/ai for 6 hours; no keys are involved.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const catalog = await listModels({});
  // A partial catalog (a source was unreachable) is served briefly so the page recovers soon.
  const cacheControl =
    catalog.errors.length > 0
      ? "public, max-age=60"
      : "public, max-age=3600, stale-while-revalidate=21600";
  return Response.json(catalog, { headers: { "cache-control": cacheControl } });
}
