// SVG safety and hygiene without a DOM (works in Convex, Node and browsers): a small tolerant XML parser, an
// allowlist sanitizer (no scripts, event handlers, foreignObject, external references or DOCTYPE entities), an
// optimizer (precision, empty groups, editor cruft), validation and palette enforcement.
import { type Color, deltaE, normalizeHex } from "@desyn/schema";

export interface SvgElement {
  tag: string;
  attrs: [name: string, value: string][];
  children: SvgChild[];
}
export type SvgChild = SvgElement | { text: string };

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feBlend",
  "feColorMatrix",
  "feFlood",
  "feComposite",
  "feMerge",
  "feMergeNode",
  "feDropShadow",
  "feMorphology",
  "feTurbulence",
  "feDisplacementMap",
]);

const DRAWING_ELEMENTS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "use",
]);

const ALLOWED_ATTRS = new Set([
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "clip-path",
  "mask",
  "filter",
  "filterUnits",
  "primitiveUnits",
  "stdDeviation",
  "dx",
  "dy",
  "in",
  "in2",
  "result",
  "mode",
  "values",
  "type",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "flood-color",
  "flood-opacity",
  "radius",
  "baseFrequency",
  "numOctaves",
  "seed",
  "stitchTiles",
  "scale",
  "xChannelSelector",
  "yChannelSelector",
  "preserveAspectRatio",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "startOffset",
  "visibility",
  "display",
  "style",
  "href",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "vector-effect",
  "paint-order",
  "mix-blend-mode",
  "isolation",
]);

const NUMERIC_ATTRS = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "stroke-width",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
]);

export class SvgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgParseError";
  }
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITY[e.toLowerCase()] ?? "";
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Parses SVG/XML into a tree. Comments, processing instructions and DOCTYPE are discarded. */
export function parseSvg(markup: string): SvgElement {
  const src = markup.replace(/^﻿/, "");
  const root: SvgElement = { tag: "#root", attrs: [], children: [] };
  const stack: SvgElement[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      const text = src.slice(i);
      if (text.trim())
        (stack[stack.length - 1] as SvgElement).children.push({ text: decodeEntities(text) });
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim())
        (stack[stack.length - 1] as SvgElement).children.push({ text: decodeEntities(text) });
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new SvgParseError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new SvgParseError("unterminated CDATA");
      (stack[stack.length - 1] as SvgElement).children.push({ text: src.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new SvgParseError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      // DOCTYPE (possibly with an internal subset): skip it entirely so entity definitions never apply.
      let depth = 0;
      let j = lt + 2;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    // Find the end of the tag, respecting quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= src.length) throw new SvgParseError("unterminated tag");
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack[stack.length - 1] as SvgElement;
      if (stack.length <= 1 || top.tag !== name) throw new SvgParseError(`unexpected </${name}>`);
      stack.pop();
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(inner);
    if (!nameMatch) throw new SvgParseError("invalid tag");
    const tag = nameMatch[1] as string;
    const attrs: [string, string][] = [];
    const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const attrSrc = inner.slice(tag.length);
    for (let m = attrRe.exec(attrSrc); m; m = attrRe.exec(attrSrc)) {
      attrs.push([m[1] as string, decodeEntities(m[3] ?? m[4] ?? "")]);
    }
    const el: SvgElement = { tag, attrs, children: [] };
    (stack[stack.length - 1] as SvgElement).children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length > 1)
    throw new SvgParseError(`unclosed <${(stack[stack.length - 1] as SvgElement).tag}>`);
  const svg = root.children.find((c): c is SvgElement => "tag" in c && c.tag === "svg");
  if (!svg) throw new SvgParseError("no <svg> root element");
  return svg;
}

export function serializeSvg(el: SvgElement): string {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  if (el.children.length === 0) return `<${el.tag}${attrs}/>`;
  const inner = el.children
    .map((c) => ("tag" in c ? serializeSvg(c) : escapeText(c.text)))
    .join("");
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

function getAttr(el: SvgElement, name: string): string | undefined {
  return el.attrs.find(([k]) => k === name)?.[1];
}

function setAttr(el: SvgElement, name: string, value: string): void {
  const existing = el.attrs.find(([k]) => k === name);
  if (existing) existing[1] = value;
  else el.attrs.push([name, value]);
}

/** A url(...) or href that points anywhere other than a fragment in the same document. */
function hasExternalRef(value: string): boolean {
  const urls = value.match(/url\(\s*(['"]?)(.*?)\1\s*\)/gi) ?? [];
  for (const u of urls) {
    const inner = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(u)?.[2] ?? "";
    if (!inner.startsWith("#")) return true;
  }
  return /javascript:|data:|vbscript:|expression\s*\(|@import/i.test(value);
}

export interface SanitizeReport {
  removedElements: string[];
  removedAttributes: string[];
}

function sanitizeStyle(style: string): string | undefined {
  const kept = style
    .split(";")
    .map((d) => d.trim())
    // CSS escapes (`u\72 l(…)`), comments and `image-set(…)` can smuggle external references past the url()
    // check, so declarations containing them are dropped.
    .filter(
      (d) => d && !hasExternalRef(d) && !/[\\]|\/\*|image-set\s*\(|behavior|binding/i.test(d),
    );
  return kept.length > 0 ? kept.join(";") : undefined;
}

function sanitizeElement(el: SvgElement, report: SanitizeReport): SvgElement | null {
  if (!ALLOWED_ELEMENTS.has(el.tag)) {
    report.removedElements.push(el.tag);
    return null;
  }
  const attrs: [string, string][] = [];
  for (const [name, raw] of el.attrs) {
    const value = raw.trim();
    // Namespace declarations are dropped everywhere and re-added canonically on the root, so content can never
    // switch an allowlisted element name into another namespace (e.g. XHTML).
    if (
      /^on/i.test(name) ||
      !ALLOWED_ATTRS.has(name) ||
      name === "xmlns" ||
      name === "xmlns:xlink"
    ) {
      report.removedAttributes.push(name);
      continue;
    }
    if (name === "href" || name === "xlink:href") {
      if (!value.startsWith("#")) {
        report.removedAttributes.push(name);
        continue;
      }
    } else if (name === "style") {
      const style = sanitizeStyle(value);
      if (!style) {
        report.removedAttributes.push(name);
        continue;
      }
      attrs.push([name, style]);
      continue;
    } else if (hasExternalRef(value)) {
      report.removedAttributes.push(name);
      continue;
    }
    attrs.push([name, value]);
  }
  const children: SvgChild[] = [];
  for (const child of el.children) {
    if ("tag" in child) {
      const clean = sanitizeElement(child, report);
      if (clean) children.push(clean);
    } else if (
      el.tag === "text" ||
      el.tag === "tspan" ||
      el.tag === "textPath" ||
      el.tag === "title" ||
      el.tag === "desc"
    ) {
      children.push(child);
    }
  }
  return { tag: el.tag, attrs, children };
}

/** Parses and sanitizes SVG markup, guaranteeing `xmlns` and a `viewBox` on the root. Throws SvgParseError. */
export function sanitizeSvg(
  markup: string,
  options: { maxBytes?: number } = {},
): { svg: string; tree: SvgElement; report: SanitizeReport } {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  if (markup.length > maxBytes)
    throw new SvgParseError(`SVG is larger than ${Math.round(maxBytes / 1024)} KB`);
  const report: SanitizeReport = { removedElements: [], removedAttributes: [] };
  const tree = sanitizeElement(parseSvg(markup), report) as SvgElement;
  setAttr(tree, "xmlns", "http://www.w3.org/2000/svg");
  let usesXlink = false;
  walk(tree, (el) => {
    if (el.attrs.some(([k]) => k === "xlink:href")) usesXlink = true;
  });
  if (usesXlink) setAttr(tree, "xmlns:xlink", "http://www.w3.org/1999/xlink");
  if (!getAttr(tree, "viewBox")) {
    const w = Number.parseFloat(getAttr(tree, "width") ?? "");
    const h = Number.parseFloat(getAttr(tree, "height") ?? "");
    setAttr(
      tree,
      "viewBox",
      `0 0 ${Number.isFinite(w) && w > 0 ? w : 100} ${Number.isFinite(h) && h > 0 ? h : 100}`,
    );
  }
  return { svg: serializeSvg(tree), tree, report };
}

function roundNumbers(value: string, precision: number): string {
  return value.replace(/-?\d*\.\d+(?:e-?\d+)?|-?\d+(?:e-?\d+)?/gi, (n) => {
    const v = Number.parseFloat(n);
    if (!Number.isFinite(v)) return n;
    const r = Number(v.toFixed(precision));
    return Object.is(r, -0) ? "0" : String(r);
  });
}

function optimizeElement(el: SvgElement, precision: number): SvgElement | null {
  const attrs = el.attrs
    .filter(([k, v]) => {
      if (k === "id" && /^(path|g|layer|svg_|Layer_)\d*$/i.test(v)) return false; // editor-generated ids
      if (k === "fill-opacity" && v === "1") return false;
      if (k === "stroke-opacity" && v === "1") return false;
      if (k === "opacity" && v === "1") return false;
      if (k === "fill-rule" && v === "nonzero") return false;
      return true;
    })
    .map(([k, v]): [string, string] => {
      if (
        k === "d" ||
        k === "points" ||
        k === "transform" ||
        k === "viewBox" ||
        NUMERIC_ATTRS.has(k)
      ) {
        return [k, roundNumbers(v, precision).replace(/\s+/g, " ").trim()];
      }
      if (k === "fill" || k === "stroke" || k === "stop-color" || k === "flood-color") {
        return [k, normalizeHex(v) ?? v];
      }
      return [k, v];
    });
  const children: SvgChild[] = [];
  for (const c of el.children) {
    if ("tag" in c) {
      const o = optimizeElement(c, precision);
      if (o) children.push(o);
    } else {
      children.push({ text: c.text.replace(/\s+/g, " ") });
    }
  }
  if ((el.tag === "g" || el.tag === "defs") && children.length === 0) return null;
  // Flatten groups that carry no attributes.
  return { tag: el.tag, attrs, children };
}

/** Rounds coordinates, drops defaults, empty groups and editor ids. */
export function optimizeSvg(markup: string, options: { precision?: number } = {}): string {
  const tree = parseSvg(markup);
  const optimized = optimizeElement(tree, options.precision ?? 2) as SvgElement;
  const flat = flattenBareGroups(optimized);
  return serializeSvg(flat);
}

function flattenBareGroups(el: SvgElement): SvgElement {
  const children: SvgChild[] = [];
  for (const c of el.children) {
    if (!("tag" in c)) {
      children.push(c);
      continue;
    }
    const f = flattenBareGroups(c);
    if (f.tag === "g" && f.attrs.length === 0) children.push(...f.children);
    else children.push(f);
  }
  return { ...el, children };
}

const NAMED_COLORS: Record<string, Color> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  navy: "#000080",
  teal: "#008080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
};

function toHex(value: string): Color | undefined {
  const v = value.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) {
    const h = (n: string) => Math.min(255, Number.parseInt(n, 10)).toString(16).padStart(2, "0");
    return `#${h(rgb[1] as string)}${h(rgb[2] as string)}${h(rgb[3] as string)}`;
  }
  const hex = normalizeHex(v);
  return hex ? hex.slice(0, 7) : undefined;
}

const COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color"];

function walk(el: SvgElement, fn: (el: SvgElement) => void): void {
  fn(el);
  for (const c of el.children) if ("tag" in c) walk(c, fn);
}

/** Every color used by the SVG (attributes and inline styles), as lowercase #rrggbb. */
export function svgColors(markup: string): Color[] {
  const found = new Set<Color>();
  walk(parseSvg(markup), (el) => {
    for (const [k, v] of el.attrs) {
      if (COLOR_ATTRS.includes(k)) {
        const c = toHex(v);
        if (c) found.add(c);
      } else if (k === "style") {
        for (const decl of v.split(";")) {
          const [prop, val] = decl.split(":").map((s) => s.trim());
          if (prop && val && COLOR_ATTRS.includes(prop)) {
            const c = toHex(val);
            if (c) found.add(c);
          }
        }
      }
    }
  });
  return [...found];
}

function nearest(color: Color, palette: readonly Color[]): Color {
  return palette.reduce(
    (best, p) => (deltaE(color, p) < deltaE(color, best) ? p : best),
    palette[0] as Color,
  );
}

/** Maps every color to its nearest palette color (OKLab distance). */
export function constrainPalette(markup: string, palette: readonly Color[]): string {
  const pal = palette.map((p) => p.slice(0, 7).toLowerCase());
  if (pal.length === 0) return markup;
  const tree = parseSvg(markup);
  walk(tree, (el) => {
    el.attrs = el.attrs.map(([k, v]): [string, string] => {
      if (COLOR_ATTRS.includes(k)) {
        const c = toHex(v);
        return [k, c ? nearest(c, pal) : v];
      }
      if (k === "style") {
        const style = v
          .split(";")
          .map((decl) => {
            const [prop, val] = decl.split(":").map((s) => s.trim());
            if (prop && val && COLOR_ATTRS.includes(prop)) {
              const c = toHex(val);
              return c ? `${prop}:${nearest(c, pal)}` : decl;
            }
            return decl;
          })
          .join(";");
        return [k, style];
      }
      return [k, v];
    });
  });
  return serializeSvg(tree);
}

export interface SvgValidation {
  ok: boolean;
  issues: string[];
  colors: Color[];
  viewBox?: [number, number, number, number];
}

/** Checks structure and constraints; issue strings are written to be fed back to a model for repair. */
export function validateSvg(
  markup: string,
  options: {
    palette?: readonly Color[];
    maxBytes?: number /** OKLab ΔE (default 0.06) */;
    tolerance?: number;
  } = {},
): SvgValidation {
  const issues: string[] = [];
  let tree: SvgElement;
  try {
    tree = parseSvg(markup);
  } catch (error) {
    return { ok: false, issues: [`Not well-formed XML: ${(error as Error).message}.`], colors: [] };
  }
  const maxBytes = options.maxBytes ?? 100 * 1024;
  if (markup.length > maxBytes)
    issues.push(
      `The SVG is ${Math.round(markup.length / 1024)} KB; keep it under ${Math.round(maxBytes / 1024)} KB by simplifying paths.`,
    );
  const vb = getAttr(tree, "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  let viewBox: [number, number, number, number] | undefined;
  if (
    vb?.length !== 4 ||
    vb.some((n) => !Number.isFinite(n)) ||
    (vb[2] as number) <= 0 ||
    (vb[3] as number) <= 0
  ) {
    issues.push('The root <svg> needs a valid viewBox like viewBox="0 0 512 512".');
  } else {
    viewBox = vb as [number, number, number, number];
  }
  let drawing = 0;
  const forbidden = new Set<string>();
  walk(tree, (el) => {
    if (DRAWING_ELEMENTS.has(el.tag)) drawing++;
    if (!ALLOWED_ELEMENTS.has(el.tag)) forbidden.add(el.tag);
    for (const [k, v] of el.attrs) {
      if (/^on/i.test(k)) forbidden.add(`${k} attribute`);
      if ((k === "href" || k === "xlink:href") && !v.startsWith("#"))
        forbidden.add("external href");
    }
  });
  if (drawing === 0) issues.push("The SVG draws nothing; add paths or shapes.");
  if (forbidden.size > 0) issues.push(`Remove disallowed content: ${[...forbidden].join(", ")}.`);
  const colors = svgColors(markup);
  if (options.palette && options.palette.length > 0) {
    const pal = options.palette.map((p) => p.slice(0, 7).toLowerCase());
    const tolerance = options.tolerance ?? 0.06;
    const off = colors.filter(
      (c) => c !== "none" && Math.min(...pal.map((p) => deltaE(c, p))) > tolerance,
    );
    if (off.length > 0)
      issues.push(`Use only the palette colors ${pal.join(", ")}; found ${off.join(", ")}.`);
  }
  return { ok: issues.length === 0, issues, colors, ...(viewBox ? { viewBox } : {}) };
}

/** Pulls the first <svg>…</svg> out of model output (code fences and prose around it are ignored). */
export function extractSvg(text: string): string | undefined {
  const start = text.search(/<svg[\s>]/i);
  if (start < 0) return undefined;
  const end = text.toLowerCase().lastIndexOf("</svg>");
  if (end < start) return undefined;
  return text.slice(start, end + 6);
}
