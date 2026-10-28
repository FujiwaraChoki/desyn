import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { appUrl, siteUrl } from "../lib/env";

// GET /og/:token -> share metadata JSON for link previews (the web app's /share/[token] page and its OG image
// route read this). Password-protected links only reveal that they are protected.

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const KIND_LABEL: Record<string, string> = {
  "social-post": "Social post",
  story: "Story",
  presentation: "Presentation",
  "business-card": "Business card",
  "book-cover": "Book cover",
  website: "One-page website",
};

function label(kind: string): string {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
}

const og = httpAction(async (ctx, request) => {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  };
  const token = new URL(request.url).pathname.slice("/og/".length).replace(/\/+$/, "");
  if (!TOKEN.test(token)) {
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
  }
  const meta = await ctx.runQuery(internal.designs.internal.ogMeta, { token });
  if (!meta) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { ...headers, "cache-control": "public, max-age=60" },
    });
  }
  const url = `${appUrl()}/share/${token}`;
  const body = meta.protected
    ? {
        title: "Protected design on Desyn",
        description: "This design is protected with a password.",
        url,
        siteName: "Desyn",
        protected: true,
        image: null,
      }
    : {
        title: meta.name,
        description: `${label(meta.kind)}${meta.pageCount > 1 ? `, ${meta.pageCount} pages` : ""}${
          meta.workspaceName ? ` by ${meta.workspaceName}` : ""
        }, made with Desyn.`,
        url,
        siteName: "Desyn",
        protected: false,
        kind: meta.kind,
        pageCount: meta.pageCount,
        width: meta.width,
        height: meta.height,
        permission: meta.permission,
        image: meta.thumbnailUrl,
        updatedAt: meta.updatedAt,
        brandUrl: siteUrl(),
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...headers, "cache-control": "public, max-age=300" },
  });
});

export function registerOgRoutes(http: HttpRouter): void {
  http.route({ pathPrefix: "/og/", method: "GET", handler: og });
}
