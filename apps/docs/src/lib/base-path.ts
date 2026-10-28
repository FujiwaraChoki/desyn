/**
 * Normalizes the DOCS_BASE_PATH build variable into a Next.js `basePath`:
 * "" (default) or a path like "/docs" without a trailing slash.
 */
export function resolveBasePath(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || value === "/") return "";
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(value)) {
    throw new Error(`DOCS_BASE_PATH must be a URL path like "/docs", got ${JSON.stringify(raw)}`);
  }
  return value.replace(/\/+$/, "");
}
