import aasa from "@/lib/apple-app-site-association.json";

// iOS universal links (a copy of apps/ios/Config/apple-app-site-association.json, kept equal by a test). Apple requires
// HTTPS, no redirects and a JSON body; nginx exempts this path from the pre-launch basic auth.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify(aasa), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}
