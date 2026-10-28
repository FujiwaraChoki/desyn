import { buildSearchIndex } from "@/lib/search-index";

// Built once at `next build` and served as a static file.
export const dynamic = "force-static";

export async function GET() {
  return Response.json(await buildSearchIndex(), {
    headers: { "cache-control": "public, max-age=0, must-revalidate" },
  });
}
