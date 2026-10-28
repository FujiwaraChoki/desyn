/** Site-wide constants. Public env vars are inlined at build time by Next. */

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v.replace(/\/+$/, "") : undefined;
}

export const SITE_URL = clean(process.env.NEXT_PUBLIC_SITE_URL) ?? "https://desyn.app";
export const APP_URL = clean(process.env.NEXT_PUBLIC_APP_URL) ?? "https://app.desyn.app";
export const SIGNUP_URL = `${APP_URL}/signup`;
export const LOGIN_URL = `${APP_URL}/login`;
/** The documentation site (apps/docs). */
export const DOCS_URL = clean(process.env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.desyn.app";
export const SELF_HOST_DOCS_URL = `${DOCS_URL}/self-hosting`;
/** Optional. Every GitHub link is hidden when this is unset. */
export const GITHUB_URL = clean(process.env.NEXT_PUBLIC_GITHUB_URL);

export const CONTACT_EMAIL = "hello@desyn.app";
export const SITE_NAME = "Desyn";
export const TAGLINE = "design at the speed of light.";
export const TITLE = "Desyn — the source-available Canva alternative";
export const DESCRIPTION =
  "Desyn is the source-available Canva alternative, built around AI. Describe what you need and it builds real, editable layers, then edit by talking to it. Web, desktop and iOS. Open source, free for non-commercial use.";

export interface NavItem {
  href: string;
  label: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: "/features", label: "Features" },
  { href: "/templates", label: "Templates" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/features/self-hosting", label: "Self-host" },
];

export interface FooterGroup {
  title: string;
  links: NavItem[];
}

export const FOOTER_GROUPS: FooterGroup[] = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/templates", label: "Templates" },
      { href: "/pricing", label: "Pricing" },
      { href: "/download", label: "Download" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Capabilities",
    links: [
      { href: "/features/ai", label: "AI that edits layers" },
      { href: "/features/templates", label: "Templates" },
      { href: "/features/brand", label: "Brand memory" },
      { href: "/features/workflows", label: "Workflows" },
      { href: "/features/collaboration", label: "Collaboration" },
      { href: "/features/self-hosting", label: "Self-hosting" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/security", label: "Security" },
      { href: "/contact", label: "Contact" },
      { href: DOCS_URL, label: "Documentation" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms", label: "Terms" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/cookies", label: "Cookies" },
      { href: "/legal/license", label: "License" },
      { href: "/legal/dpa", label: "DPA" },
    ],
  },
];

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
