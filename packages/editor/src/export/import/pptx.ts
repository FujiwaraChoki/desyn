import { unzipSync } from "fflate";

/**
 * Basic PowerPoint import: slide size, backgrounds, positioned shapes (rectangles, rounded rectangles,
 * ellipses, lines, other preset shapes as rectangles) with solid fills and outlines, text boxes with runs
 * (size, weight, italic, underline, color, font, alignment, vertical anchor), pictures (with crops), groups,
 * connectors and speaker notes. Theme colors resolve through the slide's theme; placeholders without their own
 * position inherit it from the layout / master. Charts, tables, SmartArt and effects are not converted.
 *
 * `parsePptx` is pure (zip bytes in, a neutral slide model out); `pptx-design.ts` turns it into nodes.
 */

export const EMU_PER_PX = 9525;

export interface PptxRun {
  text: string;
  sizePt: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  font: string | null;
}

export interface PptxParagraph {
  align: "left" | "center" | "right" | "justify";
  runs: PptxRun[];
  bullet: boolean;
}

export interface PptxBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export type PptxElement =
  | {
      kind: "shape";
      name: string;
      box: PptxBox;
      geometry: "rect" | "roundRect" | "ellipse" | "other";
      fill: string | null;
      stroke: { color: string; widthPx: number } | null;
      paragraphs: PptxParagraph[];
      anchor: "top" | "middle" | "bottom";
      insets: [number, number, number, number];
    }
  | {
      kind: "line";
      name: string;
      box: PptxBox;
      stroke: { color: string; widthPx: number };
    }
  | {
      kind: "picture";
      name: string;
      box: PptxBox;
      media: string;
      crop: { l: number; t: number; r: number; b: number } | null;
      alt: string | null;
    }
  | { kind: "group"; name: string; box: PptxBox; children: PptxElement[] };

export interface PptxSlide {
  index: number;
  name: string;
  background: string | null;
  backgroundMedia: string | null;
  notes: string;
  elements: PptxElement[];
}

export interface PptxDocument {
  width: number;
  height: number;
  slides: PptxSlide[];
  /** Zip path -> bytes of every referenced media file. */
  media: Map<string, { bytes: Uint8Array; mime: string }>;
  warnings: string[];
}

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

type Files = Record<string, Uint8Array>;

function xml(files: Files, path: string): Document | null {
  const bytes = files[path];
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

function kids(el: Element, ns: string, local: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children))
    if (c.namespaceURI === ns && c.localName === local) out.push(c);
  return out;
}

function kid(el: Element | null | undefined, ns: string, local: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children))
    if (c.namespaceURI === ns && c.localName === local) return c;
  return null;
}

function path(el: Element | null | undefined, ...steps: [string, string][]): Element | null {
  let cur: Element | null | undefined = el;
  for (const [ns, local] of steps) cur = kid(cur, ns, local);
  return cur ?? null;
}

function num(v: string | null | undefined, fallback = 0): number {
  const n = v === null || v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolves a relationship target relative to the part that owns it. */
export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = partPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== ".") base.push(seg);
  }
  return base.join("/");
}

function rels(files: Files, partPath: string): Map<string, { target: string; type: string }> {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const name = partPath.split("/").pop() ?? "";
  const doc = xml(files, `${dir}/_rels/${name}.rels`);
  const out = new Map<string, { target: string; type: string }>();
  if (!doc) return out;
  for (const r of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
    const id = r.getAttribute("Id");
    const target = r.getAttribute("Target");
    if (!id || !target || r.getAttribute("TargetMode") === "External") continue;
    out.set(id, { target: resolveTarget(partPath, target), type: r.getAttribute("Type") ?? "" });
  }
  return out;
}

// --- colors -------------------------------------------------------------------------------------------

type Theme = Record<string, string>;

function themeColors(doc: Document | null): Theme {
  const out: Theme = {};
  if (!doc) return out;
  const scheme = doc.getElementsByTagNameNS(NS.a, "clrScheme")[0];
  if (!scheme) return out;
  for (const c of Array.from(scheme.children)) {
    const srgb = kid(c, NS.a, "srgbClr")?.getAttribute("val");
    const sys = kid(c, NS.a, "sysClr")?.getAttribute("lastClr");
    const v = srgb ?? sys;
    if (v) out[c.localName] = `#${v.toLowerCase()}`;
  }
  return out;
}

const SCHEME_ALIAS: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function applyMods(hex: string, el: Element): string {
  let r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  let g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  let b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  let alpha = 1;
  for (const m of Array.from(el.children)) {
    const val = num(m.getAttribute("val"), 100000) / 100000;
    switch (m.localName) {
      case "lumMod":
        r *= val;
        g *= val;
        b *= val;
        break;
      case "lumOff":
        r += val;
        g += val;
        b += val;
        break;
      case "tint":
        r = r + (1 - r) * (1 - val);
        g = g + (1 - g) * (1 - val);
        b = b + (1 - b) * (1 - val);
        break;
      case "shade":
        r *= val;
        g *= val;
        b *= val;
        break;
      case "alpha":
        alpha = val;
        break;
    }
  }
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${alpha < 1 ? h(alpha) : ""}`;
}

/** Color of a fill / line element (`a:solidFill`, `a:ln` children), or null. */
function colorOf(container: Element | null, theme: Theme): string | null {
  if (!container) return null;
  const srgb = kid(container, NS.a, "srgbClr");
  if (srgb?.getAttribute("val"))
    return applyMods(`#${srgb.getAttribute("val")?.toLowerCase()}`, srgb);
  const scheme = kid(container, NS.a, "schemeClr");
  if (scheme) {
    const key = scheme.getAttribute("val") ?? "";
    const hex = theme[SCHEME_ALIAS[key] ?? key];
    return hex ? applyMods(hex, scheme) : null;
  }
  const sys = kid(container, NS.a, "sysClr");
  if (sys?.getAttribute("lastClr"))
    return applyMods(`#${sys.getAttribute("lastClr")?.toLowerCase()}`, sys);
  const prst = kid(container, NS.a, "prstClr")?.getAttribute("val");
  if (prst === "black") return "#000000";
  if (prst === "white") return "#ffffff";
  return null;
}

// --- shapes -------------------------------------------------------------------------------------------

function boxOf(xfrm: Element | null): PptxBox | null {
  if (!xfrm) return null;
  const off = kid(xfrm, NS.a, "off");
  const ext = kid(xfrm, NS.a, "ext");
  if (!off || !ext) return null;
  return {
    x: num(off.getAttribute("x")) / EMU_PER_PX,
    y: num(off.getAttribute("y")) / EMU_PER_PX,
    w: num(ext.getAttribute("cx")) / EMU_PER_PX,
    h: num(ext.getAttribute("cy")) / EMU_PER_PX,
    rotation: num(xfrm.getAttribute("rot")) / 60000,
    flipH: xfrm.getAttribute("flipH") === "1",
    flipV: xfrm.getAttribute("flipV") === "1",
  };
}

interface Placeholder {
  type: string;
  idx: string;
}

function placeholderOf(nvPr: Element | null): Placeholder | null {
  const ph = kid(nvPr, NS.p, "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type") ?? "body", idx: ph.getAttribute("idx") ?? "" };
}

/** Placeholder positions of a layout / master: by idx and by type. */
function placeholderBoxes(doc: Document | null): {
  byIdx: Map<string, PptxBox>;
  byType: Map<string, PptxBox>;
} {
  const byIdx = new Map<string, PptxBox>();
  const byType = new Map<string, PptxBox>();
  if (!doc) return { byIdx, byType };
  for (const sp of Array.from(doc.getElementsByTagNameNS(NS.p, "sp"))) {
    const ph = placeholderOf(path(sp, [NS.p, "nvSpPr"], [NS.p, "nvPr"]));
    const box = boxOf(path(sp, [NS.p, "spPr"], [NS.a, "xfrm"]));
    if (!ph || !box) continue;
    if (ph.idx && !byIdx.has(ph.idx)) byIdx.set(ph.idx, box);
    if (!byType.has(ph.type)) byType.set(ph.type, box);
  }
  return { byIdx, byType };
}

interface Ctx {
  theme: Theme;
  rels: Map<string, { target: string; type: string }>;
  layout: ReturnType<typeof placeholderBoxes>;
  master: ReturnType<typeof placeholderBoxes>;
  warnings: Set<string>;
}

function inheritedBox(ph: Placeholder | null, ctx: Ctx): PptxBox | null {
  if (!ph) return null;
  const typeKey = ph.type === "ctrTitle" ? "title" : ph.type;
  return (
    (ph.idx ? ctx.layout.byIdx.get(ph.idx) : undefined) ??
    ctx.layout.byType.get(ph.type) ??
    ctx.layout.byType.get(typeKey) ??
    ctx.master.byType.get(typeKey) ??
    ctx.master.byType.get(ph.type === "subTitle" ? "body" : typeKey) ??
    null
  );
}

function paragraphsOf(
  txBody: Element | null,
  ctx: Ctx,
  defaultSize: number | null,
): PptxParagraph[] {
  if (!txBody) return [];
  const out: PptxParagraph[] = [];
  for (const p of kids(txBody, NS.a, "p")) {
    const pPr = kid(p, NS.a, "pPr");
    const algn = pPr?.getAttribute("algn");
    const align =
      algn === "ctr"
        ? "center"
        : algn === "r"
          ? "right"
          : algn === "just" || algn === "dist"
            ? "justify"
            : "left";
    const bullet = !!kid(pPr, NS.a, "buChar") || !!kid(pPr, NS.a, "buAutoNum");
    const runs: PptxRun[] = [];
    for (const c of Array.from(p.children)) {
      if (c.namespaceURI !== NS.a) continue;
      if (c.localName === "br") {
        runs.push({
          text: "\n",
          sizePt: defaultSize,
          bold: false,
          italic: false,
          underline: false,
          color: null,
          font: null,
        });
        continue;
      }
      if (c.localName !== "r" && c.localName !== "fld") continue;
      const text = kid(c, NS.a, "t")?.textContent ?? "";
      if (!text) continue;
      const rPr = kid(c, NS.a, "rPr");
      const sz = rPr?.getAttribute("sz");
      runs.push({
        text,
        sizePt: sz ? num(sz) / 100 : defaultSize,
        bold: rPr?.getAttribute("b") === "1",
        italic: rPr?.getAttribute("i") === "1",
        underline: !!rPr?.getAttribute("u") && rPr?.getAttribute("u") !== "none",
        color: colorOf(kid(rPr, NS.a, "solidFill"), ctx.theme),
        font:
          kid(rPr, NS.a, "latin")
            ?.getAttribute("typeface")
            ?.replace(/^\+m[nj]-lt$/, "") || null,
      });
    }
    out.push({ align, runs, bullet });
  }
  // Drop trailing empty paragraphs (PowerPoint always writes one).
  while (out.length > 0 && (out[out.length - 1]?.runs.length ?? 0) === 0) out.pop();
  return out;
}

function shapeOf(sp: Element, ctx: Ctx): PptxElement | null {
  const nv = kid(sp, NS.p, "nvSpPr");
  const name = kid(nv, NS.p, "cNvPr")?.getAttribute("name") ?? "Shape";
  const spPr = kid(sp, NS.p, "spPr");
  const ph = placeholderOf(kid(nv, NS.p, "nvPr"));
  const box = boxOf(kid(spPr, NS.a, "xfrm")) ?? inheritedBox(ph, ctx);
  if (!box) return null;
  const prst = kid(spPr, NS.a, "prstGeom")?.getAttribute("prst") ?? (ph ? "rect" : "other");
  const fill = kid(spPr, NS.a, "noFill") ? null : colorOf(kid(spPr, NS.a, "solidFill"), ctx.theme);
  const ln = kid(spPr, NS.a, "ln");
  const lnColor =
    ln && !kid(ln, NS.a, "noFill") ? colorOf(kid(ln, NS.a, "solidFill"), ctx.theme) : null;
  const lnWidth = Math.max(0.5, num(ln?.getAttribute("w"), 12700) / EMU_PER_PX);
  if (prst === "line" || prst === "straightConnector1") {
    return { kind: "line", name, box, stroke: { color: lnColor ?? "#000000", widthPx: lnWidth } };
  }
  const txBody = kid(sp, NS.p, "txBody");
  const bodyPr = kid(txBody, NS.a, "bodyPr");
  const anchorAttr = bodyPr?.getAttribute("anchor");
  const defaultSize = ph?.type === "title" || ph?.type === "ctrTitle" ? 44 : ph ? 24 : 18;
  const geometry =
    prst === "rect"
      ? "rect"
      : prst === "roundRect"
        ? "roundRect"
        : prst === "ellipse"
          ? "ellipse"
          : "other";
  if (geometry === "other" && prst !== "other")
    ctx.warnings.add(`Shapes like "${prst}" were imported as rectangles.`);
  return {
    kind: "shape",
    name,
    box,
    geometry,
    fill,
    stroke: lnColor ? { color: lnColor, widthPx: lnWidth } : null,
    paragraphs: paragraphsOf(txBody, ctx, defaultSize),
    anchor: anchorAttr === "ctr" ? "middle" : anchorAttr === "b" ? "bottom" : "top",
    insets: [
      num(bodyPr?.getAttribute("tIns"), 45720) / EMU_PER_PX,
      num(bodyPr?.getAttribute("rIns"), 91440) / EMU_PER_PX,
      num(bodyPr?.getAttribute("bIns"), 45720) / EMU_PER_PX,
      num(bodyPr?.getAttribute("lIns"), 91440) / EMU_PER_PX,
    ],
  };
}

function pictureOf(pic: Element, ctx: Ctx): PptxElement | null {
  const nv = kid(pic, NS.p, "nvPicPr");
  const cNvPr = kid(nv, NS.p, "cNvPr");
  const name = cNvPr?.getAttribute("name") ?? "Picture";
  const box = boxOf(path(pic, [NS.p, "spPr"], [NS.a, "xfrm"]));
  const blipFill = kid(pic, NS.p, "blipFill");
  const embed = kid(blipFill, NS.a, "blip")?.getAttributeNS(NS.r, "embed");
  const rel = embed ? ctx.rels.get(embed) : undefined;
  if (!box || !rel) return null;
  const src = kid(blipFill, NS.a, "srcRect");
  const crop = src
    ? {
        l: num(src.getAttribute("l")) / 100000,
        t: num(src.getAttribute("t")) / 100000,
        r: num(src.getAttribute("r")) / 100000,
        b: num(src.getAttribute("b")) / 100000,
      }
    : null;
  return {
    kind: "picture",
    name,
    box,
    media: rel.target,
    crop,
    alt: cNvPr?.getAttribute("descr") || null,
  };
}

function elementsOf(tree: Element, ctx: Ctx): PptxElement[] {
  const out: PptxElement[] = [];
  for (const el of Array.from(tree.children)) {
    if (el.namespaceURI !== NS.p) continue;
    if (el.localName === "sp") {
      const s = shapeOf(el, ctx);
      if (s) out.push(s);
    } else if (el.localName === "pic") {
      const p = pictureOf(el, ctx);
      if (p) out.push(p);
    } else if (el.localName === "cxnSp") {
      const box = boxOf(path(el, [NS.p, "spPr"], [NS.a, "xfrm"]));
      const ln = path(el, [NS.p, "spPr"], [NS.a, "ln"]);
      if (box) {
        out.push({
          kind: "line",
          name: path(el, [NS.p, "nvCxnSpPr"], [NS.p, "cNvPr"])?.getAttribute("name") ?? "Connector",
          box,
          stroke: {
            color: colorOf(kid(ln, NS.a, "solidFill"), ctx.theme) ?? "#000000",
            widthPx: Math.max(0.5, num(ln?.getAttribute("w"), 12700) / EMU_PER_PX),
          },
        });
      }
    } else if (el.localName === "grpSp") {
      const xfrm = path(el, [NS.p, "grpSpPr"], [NS.a, "xfrm"]);
      const box = boxOf(xfrm);
      const chOff = kid(xfrm, NS.a, "chOff");
      const chExt = kid(xfrm, NS.a, "chExt");
      const children = elementsOf(el, ctx);
      if (!box || children.length === 0) continue;
      // Child coordinates live in the group's child space: map them into the group's box.
      const cx = num(chOff?.getAttribute("x")) / EMU_PER_PX;
      const cy = num(chOff?.getAttribute("y")) / EMU_PER_PX;
      const cw = num(chExt?.getAttribute("cx"), box.w * EMU_PER_PX) / EMU_PER_PX || box.w;
      const ch = num(chExt?.getAttribute("cy"), box.h * EMU_PER_PX) / EMU_PER_PX || box.h;
      const sx = cw > 0 ? box.w / cw : 1;
      const sy = ch > 0 ? box.h / ch : 1;
      const mapBox = (b: PptxBox): PptxBox => ({
        ...b,
        x: (b.x - cx) * sx,
        y: (b.y - cy) * sy,
        w: b.w * sx,
        h: b.h * sy,
      });
      const mapEl = (e: PptxElement): PptxElement =>
        e.kind === "group" ? { ...e, box: mapBox(e.box) } : { ...e, box: mapBox(e.box) };
      out.push({
        kind: "group",
        name: path(el, [NS.p, "nvGrpSpPr"], [NS.p, "cNvPr"])?.getAttribute("name") ?? "Group",
        box,
        children: children.map(mapEl),
      });
    } else if (el.localName === "graphicFrame") {
      ctx.warnings.add("Tables, charts and SmartArt are not imported from PowerPoint yet.");
    }
  }
  return out;
}

function notesOf(files: Files, slidePath: string, slideRels: Ctx["rels"]): string {
  const rel = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"));
  if (!rel) return "";
  const doc = xml(files, rel.target);
  if (!doc) return "";
  const parts: string[] = [];
  for (const sp of Array.from(doc.getElementsByTagNameNS(NS.p, "sp"))) {
    const ph = placeholderOf(path(sp, [NS.p, "nvSpPr"], [NS.p, "nvPr"]));
    if (ph?.type !== "body") continue;
    for (const p of Array.from(sp.getElementsByTagNameNS(NS.a, "p"))) {
      const text = Array.from(p.getElementsByTagNameNS(NS.a, "t"))
        .map((t) => t.textContent ?? "")
        .join("");
      parts.push(text);
    }
  }
  void slidePath;
  return parts.join("\n").trim();
}

function backgroundOf(doc: Document, ctx: Ctx): { color: string | null; media: string | null } {
  const bgPr = doc.getElementsByTagNameNS(NS.p, "bgPr")[0];
  if (bgPr) {
    const blip = bgPr.getElementsByTagNameNS(NS.a, "blip")[0];
    const embed = blip?.getAttributeNS(NS.r, "embed");
    const media = embed ? (ctx.rels.get(embed)?.target ?? null) : null;
    return { color: colorOf(kid(bgPr, NS.a, "solidFill"), ctx.theme), media };
  }
  const bgRef = doc.getElementsByTagNameNS(NS.p, "bgRef")[0];
  if (bgRef) return { color: colorOf(bgRef, ctx.theme), media: null };
  return { color: null, media: null };
}

export function parsePptx(bytes: Uint8Array): PptxDocument {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_TOTAL_BYTES) throw new Error("The presentation is too large when unpacked.");
      return f.name.endsWith(".xml") || f.name.endsWith(".rels") || f.name.startsWith("ppt/media/");
    },
  });
  const pres = xml(files, "ppt/presentation.xml");
  if (!pres) throw new Error("This is not a PowerPoint (.pptx) file.");
  const sldSz = pres.getElementsByTagNameNS(NS.p, "sldSz")[0];
  const width = Math.round(num(sldSz?.getAttribute("cx"), 12192000) / EMU_PER_PX);
  const height = Math.round(num(sldSz?.getAttribute("cy"), 6858000) / EMU_PER_PX);
  const presRels = rels(files, "ppt/presentation.xml");
  const warnings = new Set<string>();
  const media = new Map<string, { bytes: Uint8Array; mime: string }>();
  const slides: PptxSlide[] = [];

  const ids = Array.from(pres.getElementsByTagNameNS(NS.p, "sldId"));
  ids.forEach((sldId, index) => {
    const rid = sldId.getAttributeNS(NS.r, "id");
    const slidePath = rid ? presRels.get(rid)?.target : undefined;
    const doc = slidePath ? xml(files, slidePath) : null;
    if (!slidePath || !doc) return;
    const slideRels = rels(files, slidePath);
    const layoutPath = [...slideRels.values()].find((r) => r.type.endsWith("/slideLayout"))?.target;
    const layoutRels = layoutPath ? rels(files, layoutPath) : new Map();
    const masterPath = [...layoutRels.values()].find((r) =>
      r.type.endsWith("/slideMaster"),
    )?.target;
    const masterRels = masterPath ? rels(files, masterPath) : new Map();
    const themePath = [...masterRels.values()].find((r) => r.type.endsWith("/theme"))?.target;
    const ctx: Ctx = {
      theme: themeColors(themePath ? xml(files, themePath) : null),
      rels: slideRels,
      layout: placeholderBoxes(layoutPath ? xml(files, layoutPath) : null),
      master: placeholderBoxes(masterPath ? xml(files, masterPath) : null),
      warnings,
    };
    const tree = doc.getElementsByTagNameNS(NS.p, "spTree")[0];
    const elements = tree ? elementsOf(tree, ctx) : [];
    let bg = backgroundOf(doc, ctx);
    if (!bg.color && !bg.media && layoutPath) {
      const layoutDoc = xml(files, layoutPath);
      if (layoutDoc) bg = backgroundOf(layoutDoc, { ...ctx, rels: layoutRels });
    }
    if (!bg.color && !bg.media && masterPath) {
      const masterDoc = xml(files, masterPath);
      if (masterDoc) bg = backgroundOf(masterDoc, { ...ctx, rels: masterRels });
    }
    const collect = (els: PptxElement[]) => {
      for (const e of els) {
        if (e.kind === "picture") addMedia(e.media);
        if (e.kind === "group") collect(e.children);
      }
    };
    const addMedia = (p: string) => {
      if (media.has(p)) return;
      const b = files[p];
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME_BY_EXT[ext];
      if (b && mime) media.set(p, { bytes: b, mime });
      else
        warnings.add(
          "Some pictures use formats Desyn cannot place (EMF / WMF / TIFF) and were skipped.",
        );
    };
    collect(elements);
    if (bg.media) addMedia(bg.media);
    const title = elements.find(
      (e): e is Extract<PptxElement, { kind: "shape" }> =>
        e.kind === "shape" && e.paragraphs.length > 0,
    );
    slides.push({
      index,
      name:
        title?.paragraphs[0]?.runs
          .map((r) => r.text)
          .join("")
          .trim()
          .slice(0, 60) || `Slide ${index + 1}`,
      background: bg.color,
      backgroundMedia: bg.media && media.has(bg.media) ? bg.media : null,
      notes: notesOf(files, slidePath, slideRels),
      elements,
    });
  });
  if (slides.length === 0) throw new Error("The presentation has no slides.");
  return { width, height, slides, media, warnings: [...warnings] };
}
