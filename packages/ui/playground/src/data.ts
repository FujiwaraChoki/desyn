import type { FontOption, TreeNode } from "@desyn/ui";

export type LayerKind = "page" | "frame" | "group" | "text" | "image" | "rect" | "ellipse" | "path";

export interface Layer {
  name: string;
  kind: LayerKind;
  hidden?: boolean;
  locked?: boolean;
}

/** Layers of the sample poster shown in the editor composition. */
export const posterLayers: TreeNode<Layer>[] = [
  {
    id: "frame-poster",
    data: { name: "Golden hour poster", kind: "frame" },
    children: [
      {
        id: "grp-header",
        data: { name: "Header", kind: "group" },
        children: [
          { id: "txt-eyebrow", data: { name: "Eyebrow", kind: "text" } },
          { id: "txt-headline", data: { name: "Headline", kind: "text" } },
          { id: "txt-sub", data: { name: "Subhead", kind: "text" } },
        ],
      },
      {
        id: "grp-sun",
        data: { name: "Sun", kind: "group" },
        children: [
          { id: "ell-disc", data: { name: "Disc", kind: "ellipse" } },
          { id: "ell-corona", data: { name: "Corona", kind: "ellipse", locked: true } },
        ],
      },
      { id: "img-dunes", data: { name: "Dunes photo", kind: "image" } },
      {
        id: "grp-cta",
        data: { name: "Call to action", kind: "group" },
        children: [
          { id: "rect-button", data: { name: "Button", kind: "rect" } },
          { id: "txt-button", data: { name: "Button label", kind: "text" } },
        ],
      },
      { id: "path-wave", data: { name: "Wave ornament", kind: "path", hidden: true } },
      { id: "rect-bg", data: { name: "Background", kind: "rect", locked: true } },
    ],
  },
];

/**
 * Fonts available to the playground without network requests: the three bundled Desyn families
 * plus common system faces.
 */
export const playgroundFonts: FontOption[] = [
  { family: "Instrument Serif", category: "serif", weights: [400], source: "Brand" },
  {
    family: "Instrument Sans Variable",
    label: "Instrument Sans",
    category: "sans-serif",
    weights: [400, 500, 600, 700],
    source: "Brand",
  },
  {
    family: "JetBrains Mono Variable",
    label: "JetBrains Mono",
    category: "monospace",
    weights: [400, 500, 600, 700],
    source: "Brand",
  },
  { family: "Georgia", category: "serif" },
  { family: "Times New Roman", category: "serif" },
  { family: "Palatino", category: "serif" },
  { family: "Baskerville", category: "serif" },
  { family: "Garamond", category: "serif" },
  { family: "Didot", category: "display" },
  { family: "Arial", category: "sans-serif" },
  { family: "Helvetica", category: "sans-serif" },
  { family: "Verdana", category: "sans-serif" },
  { family: "Tahoma", category: "sans-serif" },
  { family: "Trebuchet MS", category: "sans-serif" },
  { family: "Gill Sans", category: "sans-serif" },
  { family: "Futura", category: "sans-serif" },
  { family: "Optima", category: "sans-serif" },
  { family: "Impact", category: "display" },
  { family: "Copperplate", category: "display" },
  { family: "Brush Script MT", category: "handwriting" },
  { family: "Comic Sans MS", category: "handwriting" },
  { family: "Courier New", category: "monospace" },
  { family: "Menlo", category: "monospace" },
  { family: "Monaco", category: "monospace" },
];

/** Waits for a face through the CSS Font Loading API (bundled faces load from fonts.css). */
export async function loadPlaygroundFont(font: FontOption): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await document.fonts.load(`16px "${font.family}"`);
}

export const collaborators = [
  { id: "u1", name: "Amira Haddad", color: "#FFB02E", status: "online" as const },
  { id: "u2", name: "Jonas Weber", color: "#5AA9FF", status: "online" as const },
  { id: "u3", name: "Léa Martin", color: "#4ADE80", status: "away" as const },
  { id: "u4", name: "Kenji Sato", color: "#FF6A1F" },
  { id: "u5", name: "Priya Nair", color: "#F472B6" },
  { id: "u6", name: "Diego Alvarez", color: "#A78BFA" },
];

export interface AssetRow {
  id: string;
  name: string;
  kind: "Image" | "SVG" | "Font" | "Video";
  size: number;
  updated: Date;
  owner: string;
}

const kinds: AssetRow["kind"][] = ["Image", "SVG", "Font", "Video"];
const names = [
  "dunes-at-dusk.jpg",
  "sun-mark.svg",
  "brand-wordmark.svg",
  "Instrument Serif.ttf",
  "launch-teaser.mp4",
  "studio-portrait.jpg",
  "pattern-grain.png",
  "icon-set.svg",
  "product-hero.webp",
  "menu-cover.jpg",
];

/** A deterministic asset list (sorting/virtualization demo). */
export const assetRows: AssetRow[] = Array.from({ length: 240 }, (_, i) => {
  const base = names[i % names.length] ?? "asset";
  const kind = base.endsWith(".svg")
    ? "SVG"
    : base.endsWith(".ttf")
      ? "Font"
      : base.endsWith(".mp4")
        ? "Video"
        : (kinds[0] as AssetRow["kind"]);
  return {
    id: `asset-${i}`,
    name:
      i < names.length ? base : base.replace(/(\.\w+)$/, `-${Math.floor(i / names.length) + 1}$1`),
    kind,
    size: ((i * 7919) % 9000) * 1024 + 12_000,
    updated: new Date(Date.UTC(2026, 9, 20 - (i % 30), (i * 5) % 24)),
    owner: collaborators[i % collaborators.length]?.name ?? "",
  };
});

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
