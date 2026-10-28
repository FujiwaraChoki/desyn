/*
 * Route rules shared by proxy.ts (server) and the client guards.
 */

/** Pages reachable without a session. Everything else under the app requires one. */
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/verify",
  "/magic",
  "/forgot",
  "/reset",
  "/share/",
  "/accept/",
  "/present/",
  "/api/",
  "/og/",
  "/mcp",
] as const;

/** Auth pages a signed-in user has no reason to see (they are sent to `next` or home instead). */
export const AUTH_PAGES = ["/login", "/signup", "/forgot", "/magic"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) =>
    prefix.endsWith("/")
      ? pathname.startsWith(prefix)
      : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * A same-origin relative path to continue to after signing in, or `fallback`. Rejects absolute and
 * protocol-relative URLs, backslashes and control characters so `?next=` cannot redirect off-site.
 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  for (const ch of next) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === "\\") return fallback;
  }
  try {
    const url = new URL(next, "http://desyn.invalid");
    if (url.origin !== "http://desyn.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** `/login?next=<path>` for a path the user tried to open. */
export function loginUrl(next?: string | null): string {
  const target = safeNext(next, "");
  return target && target !== "/" ? `/login?next=${encodeURIComponent(target)}` : "/login";
}

export const routes = {
  home: "/",
  projects: "/projects",
  folder: (id: string) => `/projects/${encodeURIComponent(id)}`,
  templates: "/templates",
  brand: "/brand",
  shared: "/shared",
  trash: "/trash",
  design: (id: string) => `/design/${encodeURIComponent(id)}`,
  present: (id: string) => `/present/${encodeURIComponent(id)}`,
  settings: (section = "profile") => `/settings/${section}`,
  admin: "/admin",
  onboarding: "/onboarding",
} as const;
