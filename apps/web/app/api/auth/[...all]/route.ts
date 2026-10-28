import { authServer } from "@/lib/auth-server";

/*
 * Better Auth lives in Convex HTTP actions. This handler forwards /api/auth/* to the Convex site
 * URL (headers, body and the client IP headers set by nginx included) and streams the response
 * back, so auth cookies are set on the app's own origin.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return authServer().handler.GET(request);
}

export function POST(request: Request): Promise<Response> {
  return authServer().handler.POST(request);
}
