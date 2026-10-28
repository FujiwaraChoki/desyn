/**
 * The documentation information architecture. Order here is the reading order used by the
 * sidebar and the previous/next links. Every entry maps to `content/<slug>.mdx`
 * (the empty slug maps to `content/index.mdx`).
 */
export interface NavItem {
  /** URL path without leading slash, "" for the home page. */
  slug: string;
  /** Short sidebar label. The page's own title comes from its frontmatter. */
  label: string;
}

export interface NavSection {
  id: string;
  title: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    id: "start",
    title: "Get started",
    items: [
      { slug: "", label: "Introduction" },
      { slug: "quickstart", label: "Quickstart" },
      { slug: "concepts", label: "Concepts" },
      { slug: "concepts/designs-and-pages", label: "Designs & pages" },
      { slug: "concepts/layers", label: "Layers" },
      { slug: "concepts/roles", label: "Semantic roles" },
      { slug: "concepts/workspaces", label: "Workspaces & members" },
      { slug: "concepts/brand-kits", label: "Brand kits" },
      { slug: "concepts/templates", label: "Templates" },
      { slug: "concepts/plans-and-credits", label: "Plans & credits" },
    ],
  },
  {
    id: "editor",
    title: "Editor",
    items: [
      { slug: "editor", label: "Editor tour" },
      { slug: "editor/canvas", label: "Canvas & navigation" },
      { slug: "editor/selection", label: "Selection & transform" },
      { slug: "editor/text", label: "Text" },
      { slug: "editor/shapes-and-pen", label: "Shapes & pen" },
      { slug: "editor/images", label: "Images & adjustments" },
      { slug: "editor/effects", label: "Fills, strokes & effects" },
      { slug: "editor/auto-layout", label: "Auto-layout" },
      { slug: "editor/inspector", label: "The inspector" },
      { slug: "editor/layers-and-pages", label: "Layers & pages" },
      { slug: "editor/charts-tables-qr", label: "Charts, tables & QR" },
      { slug: "editor/animation-and-video", label: "Animation & video" },
      { slug: "editor/presenting", label: "Presenting" },
      { slug: "editor/collaboration", label: "Comments & collaboration" },
      { slug: "editor/version-history", label: "Version history" },
      { slug: "editor/export", label: "Export" },
      { slug: "editor/import", label: "Import" },
      { slug: "editor/keyboard-shortcuts", label: "Keyboard shortcuts" },
    ],
  },
  {
    id: "ai",
    title: "AI",
    items: [
      { slug: "ai", label: "Overview" },
      { slug: "ai/agent", label: "The agent" },
      { slug: "ai/generating-designs", label: "Generating designs" },
      { slug: "ai/asset-tools", label: "Asset tools" },
      { slug: "ai/brand-consistency", label: "Brand consistency" },
      { slug: "ai/workflows", label: "Workflows" },
      { slug: "ai/credits-and-fair-use", label: "Credits & fair use" },
      { slug: "ai/providers-and-byok", label: "Providers & BYOK" },
      { slug: "ai/local-models", label: "Local models" },
      { slug: "ai/privacy", label: "Privacy & safety" },
    ],
  },
  {
    id: "self-hosting",
    title: "Self-hosting",
    items: [
      { slug: "self-hosting", label: "Overview & requirements" },
      { slug: "self-hosting/docker-compose", label: "Docker Compose quickstart" },
      { slug: "self-hosting/configuration", label: "Configuration reference" },
      { slug: "self-hosting/convex", label: "Convex (self-hosted)" },
      { slug: "self-hosting/storage", label: "Storage: S3, MinIO, R2" },
      { slug: "self-hosting/email", label: "Email: SES & SMTP" },
      { slug: "self-hosting/ai-providers", label: "AI providers" },
      { slug: "self-hosting/telemetry", label: "Telemetry" },
      { slug: "self-hosting/backups", label: "Backups & restore" },
      { slug: "self-hosting/upgrades", label: "Upgrades" },
      { slug: "self-hosting/reverse-proxy", label: "Reverse proxy & TLS" },
      { slug: "self-hosting/admin-console", label: "Admin console" },
      { slug: "self-hosting/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    id: "developers",
    title: "Developers",
    items: [
      { slug: "developers", label: "Overview" },
      { slug: "developers/architecture", label: "Architecture" },
      { slug: "developers/document-model", label: "Document model" },
      { slug: "developers/document-model/nodes", label: "Nodes reference" },
      { slug: "developers/document-model/paint-and-effects", label: "Paint, effects & animation" },
      { slug: "developers/operations", label: "Operations & transactions" },
      { slug: "developers/sync", label: "Sync protocol" },
      { slug: "developers/describe", label: "Describe (AI view)" },
      { slug: "developers/render-worker", label: "Render worker API" },
      { slug: "developers/api", label: "Agent API (v1)" },
      { slug: "developers/api/designs", label: "Designs endpoints" },
      { slug: "developers/api/assets", label: "Assets endpoints" },
      { slug: "developers/api/ai", label: "AI endpoints" },
      { slug: "developers/api/library", label: "Templates & brand" },
      { slug: "developers/api/account", label: "Account endpoints" },
      { slug: "developers/mcp", label: "MCP server" },
      { slug: "developers/sdk", label: "TypeScript SDK" },
      { slug: "developers/contributing", label: "Contributing" },
      { slug: "developers/license", label: "License FAQ" },
    ],
  },
  {
    id: "resources",
    title: "Resources",
    items: [
      { slug: "changelog", label: "Changelog" },
      { slug: "legal", label: "Legal" },
    ],
  },
];

export interface FlatNavItem extends NavItem {
  href: string;
  sectionId: string;
  sectionTitle: string;
  index: number;
}

export function hrefForSlug(slug: string): string {
  return slug === "" ? "/" : `/${slug}`;
}

export const FLAT_NAV: FlatNavItem[] = NAV.flatMap((section) =>
  section.items.map((item) => ({
    ...item,
    href: hrefForSlug(item.slug),
    sectionId: section.id,
    sectionTitle: section.title,
  })),
).map((item, index) => ({ ...item, index }));

/**
 * Whether an item is shown indented under its parent: its parent slug is also in the section and
 * is not the section's first (root) item, e.g. "concepts/layers" under "concepts".
 */
export function isNested(slug: string, section: NavSection): boolean {
  const cut = slug.lastIndexOf("/");
  if (cut < 0) return false;
  const parent = slug.slice(0, cut);
  const root = section.items[0]?.slug;
  return parent !== root && section.items.some((item) => item.slug === parent);
}

export function findNavItem(slug: string): FlatNavItem | undefined {
  return FLAT_NAV.find((item) => item.slug === slug);
}

export function neighbours(slug: string): { prev?: FlatNavItem; next?: FlatNavItem } {
  const item = findNavItem(slug);
  if (!item) return {};
  return { prev: FLAT_NAV[item.index - 1], next: FLAT_NAV[item.index + 1] };
}
