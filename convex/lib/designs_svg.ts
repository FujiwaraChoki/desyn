import { DOMParser } from "@xmldom/xmldom";

// SVG sanitizer for uploads and inline `SvgNode.markup` (DOCUMENT_MODEL §3: no script / foreignObject /
// external refs). The markup is parsed as XML and re-serialized from an element allowlist; everything that can
// execute code or fetch a resource is removed: <script>, <foreignObject>, animation elements (they can rewrite
// href to javascript:), event handler attributes, javascript:/vbscript: URLs, external href/url() references,
// CSS @import and DOCTYPE internal subsets (entity expansion). Only same-document "#id" references and embedded
// raster data: URLs on <image> survive.

export class SvgSanitizeError extends Error {}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
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
  "image",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "clipPath",
  "mask",
  "marker",
  "switch",
  "style",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
]);

/** Elements whose children are kept when the element itself is not allowed (harmless wrappers). */
const UNWRAP_ELEMENTS = new Set(["a"]);

const ATTR_NAME = /^[a-zA-Z_][-a-zA-Z0-9_.]*$/;
const DANGEROUS_VALUE = /(?:java|vb|live)script\s*:|expression\s*\(|-moz-binding|behavior\s*:/i;
const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

export interface SanitizedSvg {
  svg: string;
  /** True when anything was removed or rewritten beyond normalization. */
  changed: boolean;
  width?: number;
  height?: number;
}

/** Minimal DOM shapes used here (xmldom's types are structurally compatible). */
interface XNode {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<XNode>;
}
interface XAttr {
  name: string;
  localName: string | null;
  namespaceURI: string | null;
  prefix: string | null;
  value: string;
}
interface XElement extends XNode {
  localName: string | null;
  namespaceURI: string | null;
  attributes: ArrayLike<XAttr>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

const MAX_CSS_PASSES = 8;

/** One cleaning pass over CSS text. */
function cssPass(css: string): string {
  // Escapes go first: dropping them can join characters into new tokens ("u\0 rl(" -> "url("), which the
  // checks below must then see.
  let out = css.replace(/\\[0-9a-f]{1,6}\s?|\\[^\n0-9a-f]|\\$/gi, "");
  out = out.replace(/@import[^;]*;?/gi, "");
  out = out.replace(/@font-face\s*\{[^}]*\}?/gi, "");
  out = out.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _q: string, target: string) =>
    target.trim().startsWith("#") ? match : "none",
  );
  // An unclosed url( still fetches (the CSS tokenizer ends the URL at end of input).
  out = out.replace(/url\(\s*(?!['"]?\s*#)[^;}]*/gi, "none");
  // image-set() and src() accept plain strings as URLs.
  out = out.replace(/(?:-webkit-)?image-set\s*\(|\bsrc\s*\(/gi, "blocked(");
  return out.replace(new RegExp(DANGEROUS_VALUE.source, "gi"), "");
}

/**
 * Sanitize CSS (style attribute or <style> element): drop @import, @font-face, external url() / image-set(),
 * scriptable values and escapes. Removing one token can assemble another ("urjavascript:l(" -> "url("), so
 * passes repeat until the text is stable; input that keeps changing is dropped entirely.
 */
export function sanitizeCss(css: string): { css: string; changed: boolean } {
  let out = css;
  for (let pass = 0; pass < MAX_CSS_PASSES; pass++) {
    const next = cssPass(out);
    if (next === out) return { css: out, changed: out !== css };
    out = next;
  }
  return { css: "", changed: true };
}

function sanitizeHref(element: string, value: string): string | null {
  const v = value.trim();
  if (v.startsWith("#")) return v;
  if (element === "image" && SAFE_IMAGE_DATA.test(v)) return v.replace(/\s+/g, "");
  return null;
}

class Sanitizer {
  changed = false;
  usesXlink = false;

  element(el: XElement, depth: number): string {
    if (depth > 64) {
      this.changed = true;
      return "";
    }
    const name = el.localName ?? "";
    const foreignNs = el.namespaceURI !== null && el.namespaceURI !== SVG_NS;
    if (foreignNs || !ALLOWED_ELEMENTS.has(name)) {
      this.changed = true;
      return UNWRAP_ELEMENTS.has(name) && !foreignNs ? this.children(el, name, depth) : "";
    }
    const attrs = this.attributes(el, name, depth === 0);
    const inner = this.children(el, name, depth);
    return inner === "" ? `<${name}${attrs}/>` : `<${name}${attrs}>${inner}</${name}>`;
  }

  attributes(el: XElement, element: string, isRoot: boolean): string {
    let out = "";
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i] as XAttr;
      const local = attr.localName ?? attr.name;
      // Namespace declarations are re-emitted on the root.
      if (attr.prefix === "xmlns" || attr.name === "xmlns") continue;
      let name: string;
      if (attr.namespaceURI === XLINK_NS && local === "href") name = "xlink:href";
      else if (attr.prefix === "xml" && (local === "space" || local === "lang"))
        name = `xml:${local}`;
      else if (attr.namespaceURI !== null || attr.prefix) {
        this.changed = true;
        continue;
      } else name = local;
      if (!ATTR_NAME.test(name.replace(/^(xlink|xml):/, "")) || /^on/i.test(local)) {
        this.changed = true;
        continue;
      }
      let value = attr.value;
      if (local === "href") {
        const safe = sanitizeHref(element, value);
        if (safe === null) {
          this.changed = true;
          continue;
        }
        value = safe;
        if (name === "xlink:href") this.usesXlink = true;
      } else if (local === "style") {
        const css = sanitizeCss(value);
        if (css.changed) this.changed = true;
        value = css.css;
      } else {
        if (DANGEROUS_VALUE.test(value)) {
          this.changed = true;
          continue;
        }
        const css = sanitizeCss(value);
        if (css.changed) {
          this.changed = true;
          value = css.css;
        }
      }
      out += ` ${name}="${escapeAttr(value)}"`;
    }
    if (isRoot) {
      out = ` xmlns="${SVG_NS}"${this.usesXlink ? ` xmlns:xlink="${XLINK_NS}"` : ""}${out}`;
    }
    return out;
  }

  children(el: XElement, element: string, depth: number): string {
    let out = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i] as XNode;
      if (child.nodeType === ELEMENT_NODE) out += this.element(child as XElement, depth + 1);
      else if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_NODE) {
        const text = child.nodeValue ?? "";
        if (element === "style") {
          const css = sanitizeCss(text);
          if (css.changed) this.changed = true;
          out += escapeText(css.css);
        } else out += escapeText(text);
      } else {
        // Comments and processing instructions carry nothing a renderer needs.
        if (child.nodeType !== 8) this.changed = true;
      }
    }
    return out;
  }
}

const UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

function parseLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]) * (UNIT_PX[(m[2] ?? "").toLowerCase()] ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

function dimensions(root: XElement): { width?: number; height?: number } {
  const get = (name: string) => {
    for (let i = 0; i < root.attributes.length; i++) {
      const a = root.attributes[i] as XAttr;
      if ((a.localName ?? a.name) === name && !a.prefix) return a.value;
    }
    return null;
  };
  let width = parseLength(get("width"));
  let height = parseLength(get("height"));
  const viewBox = get("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    const [, , vw, vh] = viewBox as [number, number, number, number];
    if (vw > 0 && vh > 0) {
      if (width === undefined && height === undefined) {
        width = vw;
        height = vh;
      } else if (width === undefined && height !== undefined) width = (height * vw) / vh;
      else if (height === undefined && width !== undefined) height = (width * vh) / vw;
    }
  }
  return {
    ...(width !== undefined ? { width: Math.round(width * 100) / 100 } : {}),
    ...(height !== undefined ? { height: Math.round(height * 100) / 100 } : {}),
  };
}

/**
 * Sanitize the inline `markup` of every SvgNode in a node map (whole documents entering the system: import,
 * template publish). Returns a new map; throws SvgSanitizeError naming the first unusable layer.
 */
export function sanitizeNodesMarkup<N extends { type: string }>(
  nodes: Record<string, N>,
): Record<string, N> {
  const out: Record<string, N> = {};
  for (const [id, node] of Object.entries(nodes)) {
    const markup = (node as { markup?: unknown }).markup;
    if (node.type !== "svg" || typeof markup !== "string") {
      out[id] = node;
      continue;
    }
    try {
      out[id] = { ...node, markup: sanitizeSvg(markup).svg };
    } catch (err) {
      if (err instanceof SvgSanitizeError)
        throw new SvgSanitizeError(`SVG layer ${id}: ${err.message}`);
      throw err;
    }
  }
  return out;
}

/** Parse, sanitize and re-serialize SVG markup. Throws SvgSanitizeError for input that is not usable SVG. */
export function sanitizeSvg(input: string): SanitizedSvg {
  let source = input.replace(/^﻿/, "");
  let changed = false;
  const doctype = /<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i.exec(source);
  if (doctype) {
    if (doctype[1] !== undefined)
      throw new SvgSanitizeError("SVG DOCTYPE internal subsets are not allowed");
    source = source.replace(doctype[0], "");
  }
  if (/<!ENTITY/i.test(source))
    throw new SvgSanitizeError("SVG entity declarations are not allowed");

  let doc: { documentElement: XElement | null };
  try {
    doc = new DOMParser({
      locator: false,
      onError: (level, message) => {
        if (level !== "warning") throw new SvgSanitizeError(`Invalid SVG: ${message}`);
      },
    }).parseFromString(source, "image/svg+xml") as unknown as { documentElement: XElement | null };
  } catch (err) {
    if (err instanceof SvgSanitizeError) throw err;
    throw new SvgSanitizeError(`Invalid SVG: ${err instanceof Error ? err.message : String(err)}`);
  }
  const root = doc.documentElement;
  if (root?.localName !== "svg") throw new SvgSanitizeError("The file is not an SVG image");
  const s = new Sanitizer();
  // Serialize children first so `usesXlink` is known before the root attributes are written.
  const inner = s.children(root, "svg", 0);
  const attrs = s.attributes(root, "svg", true);
  const svg = inner === "" ? `<svg${attrs}/>` : `<svg${attrs}>${inner}</svg>`;
  changed = changed || s.changed;
  return { svg, changed, ...dimensions(root) };
}
