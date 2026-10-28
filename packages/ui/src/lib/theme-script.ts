import type { ThemePreference } from "@desyn/tokens";

/** localStorage key the theme preference is stored under. */
export const DEFAULT_THEME_STORAGE_KEY = "desyn-theme";

/** Type guard for stored theme preferences. */
export const isThemePreference = (v: unknown): v is ThemePreference =>
  v === "system" || v === "dark" || v === "light";

/**
 * Inline script for the document `<head>` that applies the stored theme before first paint.
 * Usage (Next.js root layout, a Server Component):
 * `<script dangerouslySetInnerHTML={{ __html: themeScript() }} />`. Lives outside the client
 * component modules so it can be called on the server.
 */
export function themeScript(
  storageKey = DEFAULT_THEME_STORAGE_KEY,
  defaultTheme: ThemePreference = "dark",
): string {
  const key = JSON.stringify(storageKey);
  const fallback = JSON.stringify(defaultTheme);
  return `(function(){try{var t=JSON.parse(localStorage.getItem(${key})||"null");if(t!=="system"&&t!=="dark"&&t!=="light")t=${fallback};document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme",${fallback})}})();`;
}
