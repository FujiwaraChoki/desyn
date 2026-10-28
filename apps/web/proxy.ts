import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { isPublicPath } from "./lib/routes";

/**
 * Sends visitors without a session cookie to /login before protected pages render. The cookie is
 * only a hint (it may be expired); the client guard in the app shell checks the real session.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || getSessionCookie(request)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/|\\.well-known/|_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon|manifest\\.webmanifest|robots\\.txt|.*\\.(?:png|jpg|jpeg|svg|webp|avif|ico|txt|xml|woff2?)$).*)",
  ],
};
