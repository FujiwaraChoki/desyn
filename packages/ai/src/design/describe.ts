// TypeScript implementation of `describe` (docs/DOCUMENT_MODEL.md §7) for hosts without the Rust engine
// (MemoryHost, offline evals) and a source of rule-based lints for `critique`. Geometry uses persisted boxes and
// text uses the approximate measurer, so results are close to — not identical with — desyn-describe.

import { approxBounds, children as childNodes, getNode, pages, type Rect } from "@desyn/doc-ops";
import {
  type Color,
  contrastRatio,
  type Description,
  type Design,
  type DNode,
  deltaE,
  ensureContrast,
  findPresetsBySize,
  type Id,
  type Issue,
  isLargeText,
  type Node,
  type Op,
  type PageNode,
  type TextNode,
} from "@desyn/schema";
import type { DescribeOptions } from "../host";
import { measureText } from "./measure";
import { describeFills, fillColor, textColor, textOf } from "./paint";

interface Flat {
  node: Node;
  box: Rect;
  z: number;
  depth: number;
  parent: Id;
}

const BACKDROP_ROLES = new Set(["background", "decoration", "pattern", "watermark"]);
const DEFAULT_NAME = /^(group|frame|rectangle|ellipse|vector|text|image|layer)( \d+)?$/i;

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, bt - y) };
}

function contains(outer: Rect, x: number, y: number): boolean {
  return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
}

export function resolvePage(design: Design, pageId?: Id): PageNode {
  const all = pages(design);
  const page = (pageId ? all.find((p) => p.id === pageId) : undefined) ?? all[0];
  if (!page) throw new Error("design has no pages");
  return page;
}

function flatten(design: Design, page: PageNode): Flat[] {
  const out: Flat[] = [];
  let z = 0;
  const walk = (parentId: Id, depth: number) => {
    for (const child of childNodes(design, parentId)) {
      const box = approxBounds(design, child.id) as Rect;
      out.push({ node: child, box, z: z++, depth, parent: parentId });
      if ("children" in child && child.type !== "root") walk(child.id, depth + 1);
    }
  };
  walk(page.id, 0);
  return out;
}

function isVisible(design: Design, node: Node): boolean {
  let current: Node | undefined = node;
  while (current && current.type !== "page") {
    if (!current.visible || current.opacity <= 0.01) return false;
    current = current.parent ? getNode(design, current.parent) : undefined;
  }
  return true;
}

function paintOf(node: Node, design: Design): Color | undefined {
  switch (node.type) {
    case "text":
      return textColor(node, design);
    case "line":
      return fillColor(node.strokes[0]?.fills, design);
    case "qr":
      return node.fg;
    default:
      return "fills" in node ? fillColor(node.fills, design) : undefined;
  }
}

/** Opaque color directly behind a point (top-most earlier node with a solid paint), else the page background. */
function colorBehind(
  flat: Flat[],
  index: number,
  page: PageNode,
  design: Design,
): { color: Color | undefined; onImage: boolean } {
  const self = flat[index] as Flat;
  const cx = self.box.x + self.box.width / 2;
  const cy = self.box.y + self.box.height / 2;
  for (let i = index - 1; i >= 0; i--) {
    const f = flat[i] as Flat;
    if (f.node.type === "text" || f.node.type === "line" || !isVisible(design, f.node)) continue;
    if (!contains(f.box, cx, cy)) continue;
    if (f.node.type === "image" || f.node.type === "video")
      return { color: undefined, onImage: true };
    if ("fills" in f.node) {
      if (f.node.fills.some((fl) => fl.type === "image" && fl.visible !== false)) {
        return { color: undefined, onImage: true };
      }
      const c = fillColor(f.node.fills, design);
      if (c) return { color: c.slice(0, 7), onImage: false };
    }
  }
  if (page.background.some((f) => f.type === "image")) return { color: undefined, onImage: true };
  return { color: fillColor(page.background, design)?.slice(0, 7) ?? "#ffffff", onImage: false };
}

function minTextSize(page: PageNode): number {
  if (page.unit !== "px") return 8; // ≈ 6 pt in print
  return Math.max(10, Math.round(Math.min(page.width, page.height) * 0.016));
}

function safeMargin(page: PageNode): { t: number; r: number; b: number; l: number } {
  const preset = findPresetsBySize(page.width, page.height)[0];
  if (preset?.safeArea) {
    const s = preset.safeArea;
    return { t: s.top, r: s.right, b: s.bottom, l: s.left };
  }
  const m = Math.round(Math.min(page.width, page.height) * 0.04);
  return { t: m, r: m, b: m, l: m };
}

function imageKind(node: Node): NonNullable<DNode["image"]>["kind"] {
  const role = node.role;
  if (role === "logo" || role === "brand-mark") return "logo";
  if (role === "icon") return "icon";
  if (role === "illustration" || node.type === "svg") return "illustration";
  if (role === "photo" || role === "hero" || role === "product" || role === "avatar")
    return "photo";
  return node.type === "image" ? "photo" : "unknown";
}

function semanticOf(design: Design, node: Node): string | undefined {
  if (!("children" in node) || node.type === "root" || node.type === "page") return undefined;
  const kids = childNodes(design, node.id);
  if (kids.length === 0) return undefined;
  const roles = kids.map((k) => k.role ?? "");
  const types = kids.map((k) => k.type);
  const hasImage =
    types.some((t) => t === "image") || roles.some((r) => r === "photo" || r === "product");
  const hasText = types.includes("text");
  const hasPrice =
    roles.includes("price") ||
    kids.some((k) => k.type === "text" && /[$€£¥]\s?\d|\d\s?[$€£¥]/.test(textOf(k)));
  const hasButton = roles.includes("button") || roles.includes("cta");
  if (hasImage && hasText && hasPrice)
    return `product card: image + title + price${hasButton ? " + button" : ""}`;
  if (kids.length === 2 && types.includes("text") && kids.some((k) => "fills" in k)) {
    const label = kids.find((k) => k.type === "text") as TextNode;
    if (textOf(label).length <= 24) return "button: shape + short label";
  }
  if (kids.length >= 3) {
    const sizes = kids.map(
      (k) => `${Math.round(k.width / 4)}x${Math.round(k.height / 4)}:${k.type}`,
    );
    const same = sizes.filter((s) => s === sizes[0]).length;
    if (same === kids.length) return `list of ${kids.length} similar ${kids[0]?.type ?? "item"}s`;
  }
  if (types.every((t) => t === "text")) {
    return kids.length > 1 ? "text block: stacked text" : "text";
  }
  if (types.some((t) => t === "svg") && hasText) return "labelled icon";
  if (hasImage && hasText) return "media with caption";
  return undefined;
}

export interface DescribeContext {
  selection?: Id[];
}

export function describeDesign(design: Design, options: DescribeOptions = {}): Description {
  const page = resolvePage(design, options.pageId);
  const pageIndex = pages(design).findIndex((p) => p.id === page.id);
  const pageRect: Rect = { x: 0, y: 0, width: page.width, height: page.height };
  const flat = flatten(design, page);
  const visible = flat.filter((f) => isVisible(design, f.node));
  const issues: Issue[] = [];
  const flags = new Map<Id, string[]>();
  const flag = (id: Id, f: string) => {
    const list = flags.get(id) ?? [];
    if (!list.includes(f)) list.push(f);
    flags.set(id, list);
  };
  const minSize = minTextSize(page);
  const margin = safeMargin(page);
  const pageArea = area(pageRect);

  // Text metrics ------------------------------------------------------------------------------------------------
  const texts = visible.filter((f): f is Flat & { node: TextNode } => f.node.type === "text");
  const measured = new Map<Id, ReturnType<typeof measureText>>();
  for (const t of texts) {
    measured.set(
      t.node.id,
      measureText({
        text: t.node.runs,
        style: t.node.style,
        paragraph: t.node.paragraph,
        ...(t.node.autoResize === "width" ? {} : { width: t.node.width }),
      }),
    );
  }

  // Per-node checks -----------------------------------------------------------------------------------------------
  for (const f of visible) {
    const n = f.node;
    const inter = intersect(f.box, pageRect);
    const isBackdrop = BACKDROP_ROLES.has(n.role ?? "") || area(f.box) >= pageArea * 0.85;
    if (area(f.box) > 0 && area(inter) === 0) {
      flag(n.id, "off-page");
      issues.push({
        severity: "error",
        code: "off-page",
        ids: [n.id],
        message: `"${n.name}" is completely outside the page.`,
        ...(f.depth === 0
          ? {
              fix: [
                {
                  op: "update",
                  id: n.id,
                  set: {
                    x: Math.max(0, Math.min(page.width - n.width, n.x)),
                    y: Math.max(0, Math.min(page.height - n.height, n.y)),
                  },
                } as Op,
              ],
            }
          : {}),
      });
      continue;
    }
    if (!isBackdrop && area(inter) < area(f.box) - 1 && f.depth === 0 && n.type !== "line") {
      flag(n.id, "overflows-page");
    }
    if (
      !isBackdrop &&
      f.depth === 0 &&
      (n.type === "text" || n.role === "logo" || n.role === "cta")
    ) {
      const b = f.box;
      if (
        b.x < margin.l - 0.5 ||
        b.y < margin.t - 0.5 ||
        b.x + b.width > page.width - margin.r + 0.5 ||
        b.y + b.height > page.height - margin.b + 0.5
      ) {
        flag(n.id, "unsafe-margin");
        issues.push({
          severity: "warn",
          code: "unsafe-margin",
          ids: [n.id],
          message: `"${n.name}" sits inside the ${margin.l}px safe margin; keep text and logos away from the edges.`,
        });
      }
    }
    if (
      n.type === "image" ||
      (n.type === "svg" && n.role !== "decoration" && n.role !== "pattern")
    ) {
      if (!n.alt && n.role !== "background" && n.role !== "decoration" && n.role !== "pattern") {
        issues.push({
          severity: "info",
          code: "missing-alt",
          ids: [n.id],
          message: `"${n.name}" has no alt text.`,
        });
      }
      if (n.type === "image") {
        const asset = design.assets[n.assetId];
        const dpiScale = page.unit === "px" ? 1 : 300 / 96;
        if (asset?.width && asset.height) {
          const needW = f.box.width * dpiScale;
          const needH = f.box.height * dpiScale;
          if (asset.width < needW * 0.9 || asset.height < needH * 0.9) {
            flag(n.id, "low-res");
            issues.push({
              severity: "warn",
              code: "image-low-res",
              ids: [n.id],
              message: `"${n.name}" is ${asset.width}x${asset.height}px but needs about ${Math.round(needW)}x${Math.round(needH)}px; upscale or replace it.`,
            });
          }
        }
      }
    }
    if (
      "children" in n &&
      (n.type === "group" || n.type === "frame") &&
      n.children.length >= 2 &&
      !n.role &&
      DEFAULT_NAME.test(n.name)
    ) {
      issues.push({
        severity: "info",
        code: "unlabeled-group",
        ids: [n.id],
        message: `"${n.name}" groups ${n.children.length} layers but has no meaningful name or role.`,
      });
    }
  }

  // Text checks -------------------------------------------------------------------------------------------------
  for (const t of texts) {
    const n = t.node;
    const m = measured.get(n.id) as ReturnType<typeof measureText>;
    const idx = flat.indexOf(t);
    if (n.style.fontSize < minSize && textOf(n).trim().length > 0) {
      flag(n.id, "tiny-text");
      issues.push({
        severity: "warn",
        code: "tiny-text",
        ids: [n.id],
        message: `"${n.name}" is ${n.style.fontSize}px; the minimum readable size here is about ${minSize}px.`,
        fix: [{ op: "patch", id: n.id, path: ["style", "fontSize"], value: minSize }],
      });
    }
    const fg = textColor(n, design)?.slice(0, 7);
    const behind = colorBehind(flat, idx, page, design);
    if (fg && behind.color) {
      const ratio = contrastRatio(fg, behind.color);
      const large = isLargeText(n.style.fontSize, n.style.fontWeight);
      const target = large ? 3 : 4.5;
      if (ratio < target) {
        flag(n.id, "low-contrast");
        const fixed = ensureContrast(fg, behind.color, target + 0.2);
        issues.push({
          severity: ratio < target * 0.7 ? "error" : "warn",
          code: "low-contrast",
          ids: [n.id],
          message: `"${n.name}" has ${round(ratio, 2)}:1 contrast on ${behind.color} (needs ${target}:1).`,
          fix: [
            {
              op: "patch",
              id: n.id,
              path: ["style", "fills"],
              value: [{ type: "solid", color: fixed }],
            },
          ],
        });
      }
    } else if (behind.onImage) {
      flag(n.id, "on-image");
    }
    if (n.autoResize === "none" && m.h > n.height + 2) {
      flag(n.id, "text-overflow");
      issues.push({
        severity: "warn",
        code: "text-overflow",
        ids: [n.id],
        message: `"${n.name}" needs about ${m.h}px of height but its box is ${round(n.height, 0)}px.`,
        fix: [{ op: "update", id: n.id, set: { height: m.h } }],
      });
    } else if (n.maxLines !== undefined && m.lines > n.maxLines) {
      flag(n.id, "text-overflow");
      issues.push({
        severity: "info",
        code: "text-overflow",
        ids: [n.id],
        message: `"${n.name}" wraps to ${m.lines} lines and is truncated at ${n.maxLines}.`,
      });
    }
    const lines = measured.get(n.id)?.lines ?? 1;
    if (lines >= 2 && n.style.fontSize >= minSize * 1.6) {
      const text = textOf(n);
      const lastWords = text.trim().split(/\s+/);
      const m2 = measureText({
        text: n.runs,
        style: n.style,
        paragraph: n.paragraph,
        width: n.width,
      });
      const lastLineWidth = m2.lineWidths[m2.lineWidths.length - 1] ?? 0;
      if (lastWords.length > 2 && lastLineWidth < n.width * 0.2) {
        issues.push({
          severity: "info",
          code: "orphan-line",
          ids: [n.id],
          message: `"${n.name}" ends with a lone short last line; rebalance the line breaks or adjust the width.`,
        });
      }
    }
  }

  // Overlaps between text blocks ----------------------------------------------------------------------------------
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i] as Flat;
      const b = texts[j] as Flat;
      const inter = area(intersect(a.box, b.box));
      if (inter > Math.min(area(a.box), area(b.box)) * 0.1) {
        flag(a.node.id, `overlaps:${b.node.id}`);
        flag(b.node.id, `overlaps:${a.node.id}`);
        issues.push({
          severity: "warn",
          code: "overlap",
          ids: [a.node.id, b.node.id],
          message: `"${a.node.name}" and "${b.node.name}" overlap.`,
        });
      }
    }
  }

  // Alignment ---------------------------------------------------------------------------------------------------
  const blocks = visible.filter(
    (f) => f.depth === 0 && !BACKDROP_ROLES.has(f.node.role ?? "") && area(f.box) < pageArea * 0.85,
  );
  const alignments: Description["grid"]["alignments"] = [];
  const edges: [axis: "x" | "y", (r: Rect) => number][] = [
    ["x", (r) => r.x],
    ["x", (r) => r.x + r.width / 2],
    ["x", (r) => r.x + r.width],
    ["y", (r) => r.y],
    ["y", (r) => r.y + r.height / 2],
    ["y", (r) => r.y + r.height],
  ];
  for (const [axis, get] of edges) {
    const groups = new Map<number, Id[]>();
    for (const b of blocks) {
      const pos = Math.round(get(b.box) * 2) / 2;
      const key = [...groups.keys()].find((k) => Math.abs(k - pos) <= 0.5) ?? pos;
      groups.set(key, [...(groups.get(key) ?? []), b.node.id]);
    }
    for (const [pos, ids] of groups)
      if (ids.length >= 2) alignments.push({ axis, pos: round(pos), ids });
  }
  // Near misses on left edges / centers (1–6 px apart) are misalignments.
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i] as Flat;
      const b = blocks[j] as Flat;
      const dl = Math.abs(a.box.x - b.box.x);
      const dc = Math.abs(a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2));
      if ((dl > 0.75 && dl <= 6) || (dc > 0.75 && dc <= 6 && dl > 6)) {
        const left = dl <= 6;
        const delta = left
          ? a.box.x - b.box.x
          : a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2);
        issues.push({
          severity: "info",
          code: "misaligned",
          ids: [a.node.id, b.node.id],
          message: `"${a.node.name}" and "${b.node.name}" are ${round(Math.abs(delta))}px off ${left ? "left" : "center"} alignment.`,
          fix: [{ op: "update", id: b.node.id, set: { x: round(b.node.x + delta, 2) } }],
        });
      }
    }
  }

  // Spacing rhythm ----------------------------------------------------------------------------------------------
  const stack = [...blocks].sort((a, b) => a.box.y - b.box.y);
  const gaps: { gap: number; ids: [Id, Id] }[] = [];
  for (let i = 1; i < stack.length; i++) {
    const prev = stack[i - 1] as Flat;
    const cur = stack[i] as Flat;
    const overlapX =
      Math.min(prev.box.x + prev.box.width, cur.box.x + cur.box.width) -
      Math.max(prev.box.x, cur.box.x);
    const gap = cur.box.y - (prev.box.y + prev.box.height);
    if (overlapX > 0 && gap > 0) gaps.push({ gap, ids: [prev.node.id, cur.node.id] });
  }
  let spacingRhythm: number | undefined;
  if (gaps.length > 0) {
    const counts = new Map<number, number>();
    for (const g of gaps) {
      const k = Math.max(4, Math.round(g.gap / 4) * 4);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    spacingRhythm = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (gaps.length >= 3) {
      const values = gaps.map((g) => g.gap);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const spread = Math.max(...values) - Math.min(...values);
      if (spread > 8 && spread > mean * 0.6) {
        issues.push({
          severity: "info",
          code: "uneven-spacing",
          ids: [...new Set(gaps.flatMap((g) => g.ids))],
          message: `Vertical gaps between stacked blocks vary from ${round(Math.min(...values), 0)} to ${round(Math.max(...values), 0)}px; use a consistent rhythm.`,
        });
      }
    }
  }

  // Fonts, typography -----------------------------------------------------------------------------------------------
  const fontMap = new Map<string, { weights: Set<number>; usedBy: number }>();
  const sizeWeight = new Map<number, number>();
  for (const t of texts) {
    const e = fontMap.get(t.node.style.fontFamily) ?? { weights: new Set<number>(), usedBy: 0 };
    e.weights.add(t.node.style.fontWeight);
    for (const r of t.node.runs) {
      if (r.style?.fontFamily && r.style.fontFamily !== t.node.style.fontFamily) {
        const re = fontMap.get(r.style.fontFamily) ?? { weights: new Set<number>(), usedBy: 0 };
        re.weights.add(r.style.fontWeight ?? t.node.style.fontWeight);
        re.usedBy++;
        fontMap.set(r.style.fontFamily, re);
      }
    }
    e.usedBy++;
    fontMap.set(t.node.style.fontFamily, e);
    const size = t.node.style.fontSize;
    sizeWeight.set(size, (sizeWeight.get(size) ?? 0) + textOf(t.node).length);
  }
  const fonts = [...fontMap.entries()].map(([family, e]) => ({
    family,
    weights: [...e.weights].sort((a, b) => a - b),
    usedBy: e.usedBy,
  }));
  if (fonts.length > 3) {
    issues.push({
      severity: "warn",
      code: "too-many-fonts",
      ids: texts.map((t) => t.node.id),
      message: `${fonts.length} font families are used; limit to two (three at most).`,
    });
  }
  const scale = [...sizeWeight.keys()].sort((a, b) => b - a);
  const headlineSize = scale[0];
  const bodyCandidates = [...sizeWeight.entries()].filter(([s]) => s !== headlineSize);
  const bodySize = bodyCandidates.sort((a, b) => b[1] - a[1])[0]?.[0];
  const ratio = headlineSize && bodySize ? round(headlineSize / bodySize, 2) : undefined;
  if (texts.length >= 2 && ratio !== undefined && ratio < 1.4) {
    issues.push({
      severity: "warn",
      code: "weak-hierarchy",
      ids: texts.map((t) => t.node.id),
      message: `The largest text is only ${ratio}x the body size; make the headline clearly dominant (1.6x or more).`,
    });
  }

  // Palette -------------------------------------------------------------------------------------------------------
  const paletteWeights = new Map<Color, number>();
  const addColor = (c: Color | undefined, w: number) => {
    if (!c || w <= 0) return;
    const hex = c.slice(0, 7);
    const key = [...paletteWeights.keys()].find((k) => deltaE(k, hex) < 0.025) ?? hex;
    paletteWeights.set(key, (paletteWeights.get(key) ?? 0) + w);
  };
  // The page background only shows where no opaque full-bleed layer covers it.
  const covered = visible.some(
    (f) =>
      f.depth === 0 &&
      area(intersect(f.box, pageRect)) >= pageArea * 0.98 &&
      f.node.opacity >= 0.99 &&
      ((f.node.type === "image" && f.node.fit !== "fit") ||
        ("fills" in f.node &&
          f.node.fills.some(
            (fl) =>
              (fl.type === "solid" || fl.type === "image") &&
              fl.visible !== false &&
              (fl.opacity ?? 1) >= 0.99,
          ))),
  );
  if (!covered) addColor(fillColor(page.background, design), pageArea);
  for (const f of visible) {
    const c = paintOf(f.node, design);
    const a = area(intersect(f.box, pageRect));
    addColor(c, f.node.type === "text" ? a * 0.2 : f.node.type === "line" ? a * 0.05 + 1 : a);
  }
  const totalW = [...paletteWeights.values()].reduce((s, v) => s + v, 0) || 1;
  const palette = [...paletteWeights.entries()]
    .map(([color, w]) => ({ color, share: round(w / totalW, 3) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 8);
  const distinct = [...paletteWeights.keys()];
  if (distinct.length > 7) {
    issues.push({
      severity: "info",
      code: "too-many-colors",
      ids: [],
      message: `${distinct.length} distinct colors are in use; a focused palette of 3–5 reads better.`,
    });
  }

  // Margins -------------------------------------------------------------------------------------------------------
  const content = blocks.length > 0 ? blocks : visible;
  const margins =
    content.length > 0
      ? {
          t: round(Math.max(0, Math.min(...content.map((c) => c.box.y)))),
          l: round(Math.max(0, Math.min(...content.map((c) => c.box.x)))),
          r: round(
            Math.max(0, page.width - Math.max(...content.map((c) => c.box.x + c.box.width))),
          ),
          b: round(
            Math.max(0, page.height - Math.max(...content.map((c) => c.box.y + c.box.height))),
          ),
        }
      : { t: 0, r: 0, b: 0, l: 0 };

  // Hierarchy -----------------------------------------------------------------------------------------------------
  const scored = visible
    .filter(
      (f) =>
        f.node.type === "text" ||
        (f.depth <= 2 && !BACKDROP_ROLES.has(f.node.role ?? "") && area(f.box) < pageArea * 0.85),
    )
    .map((f) => {
      const n = f.node;
      if (n.type === "text") {
        const fg = textColor(n, design)?.slice(0, 7);
        const bg = colorBehind(flat, flat.indexOf(f), page, design).color;
        const c = fg && bg ? Math.min(contrastRatio(fg, bg), 10) / 10 : 0.6;
        const score = n.style.fontSize ** 1.3 * (0.4 + c) * (n.style.fontWeight >= 600 ? 1.15 : 1);
        return {
          id: n.id,
          score,
          reason: `${n.style.fontSize}px text, contrast ${round(c * 10, 1)}:1`,
        };
      }
      const a = area(intersect(f.box, pageRect));
      const score = Math.sqrt(a) * (n.type === "image" || n.type === "svg" ? 1.1 : 0.6);
      return {
        id: n.id,
        score,
        reason: `${n.type} covering ${round((a / pageArea) * 100, 0)}% of the page`,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  const hierarchy = scored.map((s, i) => ({ id: s.id, rank: i + 1, reason: s.reason }));

  // Tree --------------------------------------------------------------------------------------------------------
  const maxDepth = options.maxDepth ?? 8;
  const byParent = new Map<Id, Flat[]>();
  for (const f of flat) byParent.set(f.parent, [...(byParent.get(f.parent) ?? []), f]);
  const toDNode = (f: Flat): DNode => {
    const n = f.node;
    const d: DNode = {
      id: n.id,
      type: n.type,
      name: n.name,
      box: {
        x: round(f.box.x),
        y: round(f.box.y),
        w: round(f.box.width),
        h: round(f.box.height),
        rotation: round(n.rotation),
      },
      z: f.z,
      visible: n.visible,
      locked: n.locked,
      opacity: n.opacity,
    };
    if (n.role) d.role = n.role;
    if (n.type === "text") {
      d.text = textOf(n);
      const color = textColor(n, design)?.slice(0, 7) ?? "#000000";
      d.font = {
        family: n.style.fontFamily,
        size: n.style.fontSize,
        weight: n.style.fontWeight,
        color,
        align: n.paragraph.align,
        lines: measured.get(n.id)?.lines ?? 1,
      };
    } else if ("fills" in n) {
      d.fill = describeFills(n.fills, design);
    }
    if (n.type === "image") {
      d.image = { assetId: n.assetId, kind: imageKind(n), ...(n.alt ? { alt: n.alt } : {}) };
    } else if (n.type === "svg" && n.assetId) {
      d.image = { assetId: n.assetId, kind: imageKind(n), ...(n.alt ? { alt: n.alt } : {}) };
    }
    const semantic = semanticOf(design, n);
    if (semantic) d.semantic = semantic;
    const fl = flags.get(n.id);
    if (fl?.length) d.flags = fl;
    const kids = byParent.get(n.id);
    if (kids?.length && f.depth + 1 < maxDepth) d.children = kids.map(toDNode);
    return d;
  };
  const tree = (byParent.get(page.id) ?? []).map(toDNode);

  const selection = (options.selection ?? []).filter((id) => getNode(design, id));
  const description: Description = {
    design: {
      id: design.id,
      name: design.name,
      kind: design.kind,
      pageCount: pages(design).length,
      ...(typeof design.meta.locale === "string" ? { locale: design.meta.locale } : {}),
    },
    page: {
      id: page.id,
      index: Math.max(0, pageIndex),
      width: page.width,
      height: page.height,
      unit: page.unit,
      background: describeFills(page.background, design),
    },
    selection,
    tree,
    palette,
    fonts,
    typography: {
      scale,
      ...(headlineSize !== undefined ? { headlineSize } : {}),
      ...(bodySize !== undefined ? { bodySize } : {}),
      ...(ratio !== undefined ? { ratio } : {}),
    },
    grid: { margins, alignments, ...(spacingRhythm !== undefined ? { spacingRhythm } : {}) },
    hierarchy,
    issues,
  };
  return description;
}

/** Solid color directly behind a node's center on its page (`undefined` when it sits on an image). */
export function backdropColorOf(design: Design, id: Id): Color | undefined {
  const node = getNode(design, id);
  if (!node) return undefined;
  const page = pages(design).find((p) => flatten(design, p).some((f) => f.node.id === id));
  if (!page) return undefined;
  const flat = flatten(design, page);
  const index = flat.findIndex((f) => f.node.id === id);
  return colorBehind(flat, index, page, design).color;
}
