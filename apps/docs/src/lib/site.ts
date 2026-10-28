/** Public URLs and identity used across the docs site. */
export const SITE = {
  name: "Desyn Docs",
  /** Canonical origin of the standalone docs deployment. Override with DOCS_SITE_URL. */
  url: (process.env.DOCS_SITE_URL ?? "https://docs.desyn.app").replace(/\/+$/, ""),
  description:
    "Guides and reference for Desyn, the AI-native design suite: the editor, the AI agent, self-hosting, the document model and the Agent API.",
  marketingUrl: "https://desyn.app",
  appUrl: "https://app.desyn.app",
  apiUrl: "https://api.desyn.app",
  legalUrl: "https://desyn.app/legal",
  contactEmail: "hello@desyn.app",
} as const;

/** Base path the site was built with ("" or e.g. "/docs"). Inlined by next.config `env`. */
export const BASE_PATH = process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? "";

/** Prefix an absolute site path with the base path (for raw <a>, fetch and static files). */
export function withBasePath(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}
