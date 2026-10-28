import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { edition } from "../lib/env";

/** GET /healthz: liveness + database reachability. Never exposes configuration details. */
const healthz = httpAction(async (ctx) => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    const ping = await ctx.runQuery(internal.admin.system.ping, {});
    return new Response(
      JSON.stringify({ ok: true, service: "desyn-convex", edition: edition(), time: ping.time }),
      { status: 200, headers },
    );
  } catch {
    return new Response(JSON.stringify({ ok: false, service: "desyn-convex" }), {
      status: 503,
      headers,
    });
  }
});

export function registerHealthRoutes(http: HttpRouter): void {
  http.route({ path: "/healthz", method: "GET", handler: healthz });
}
