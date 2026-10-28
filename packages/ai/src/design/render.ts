// Approximate page renderer for MemoryHost: paints backgrounds, shapes, image placeholders and greeked text lines
// into an RGBA canvas and encodes a PNG. Composition, color masses and text placement match the real renderer
// closely enough for critique; glyphs, gradients and effects are simplified.

import { approxBounds, children as childNodes } from "@desyn/doc-ops";
import type { Design, Node } from "@desyn/schema";
import type { RenderOptions, RenderResult } from "../host";
import { resolvePage } from "./describe";
import { measureText } from "./measure";
import { fillColor, textColor } from "./paint";
import { Canvas, type Clip, encodePng, hexToRgba, intersectClip } from "./raster";

const IMAGE_PLACEHOLDER = "#9a968e";
const SVG_PLACEHOLDER = "#b9b4aa";

export function renderDesign(design: Design, options: RenderOptions = {}): RenderResult {
  const page = resolvePage(design, options.pageId);
  const region = options.region ?? { x: 0, y: 0, w: page.width, h: page.height };
  const maxSize = options.maxSize ?? 1024;
  const scale = options.scale ?? Math.min(4, maxSize / Math.max(region.w, region.h));
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  const bg =
    options.background === "transparent"
      ? undefined
      : hexToRgba(options.background ?? fillColor(page.background, design) ?? "#ffffff");
  const canvas = new Canvas(width, height, bg);
  const tx = (x: number) => (x - region.x) * scale;
  const ty = (y: number) => (y - region.y) * scale;

  const paintNode = (node: Node, opacity: number, clip: Clip | undefined) => {
    if (!node.visible) return;
    const alpha = opacity * node.opacity;
    if (alpha <= 0.01) return;
    const b = approxBounds(design, node.id);
    if (!b) return;
    const x = tx(b.x);
    const y = ty(b.y);
    const w = b.width * scale;
    const h = b.height * scale;
    const radius =
      "cornerRadius" in node
        ? (typeof node.cornerRadius === "number"
            ? node.cornerRadius
            : Math.max(...node.cornerRadius)) * scale
        : 0;
    switch (node.type) {
      case "text": {
        const color = textColor(node, design) ?? "#111111";
        const m = measureText({
          text: node.runs,
          style: node.style,
          paragraph: node.paragraph,
          ...(node.autoResize === "width" ? {} : { width: node.width }),
        });
        const lh = m.lines > 0 ? m.h / m.lines : node.style.fontSize * 1.2;
        const totalH = m.h * scale;
        const offsetY =
          node.verticalAlign === "middle"
            ? (h - totalH) / 2
            : node.verticalAlign === "bottom"
              ? h - totalH
              : 0;
        m.lineWidths.forEach((lw, i) => {
          const lineW = Math.min(lw, node.width) * scale;
          const lineX =
            node.paragraph.align === "center"
              ? x + (w - lineW) / 2
              : node.paragraph.align === "right"
                ? x + w - lineW
                : x;
          const barH = node.style.fontSize * 0.62 * scale;
          const lineY = y + offsetY + (i * lh + (lh - node.style.fontSize * 0.62) / 2) * scale;
          canvas.fillRect(lineX, lineY, lineW, Math.max(1, barH), hexToRgba(color, alpha), clip);
        });
        return;
      }
      case "image":
        canvas.fillRoundRect(x, y, w, h, radius, hexToRgba(IMAGE_PLACEHOLDER, alpha), clip);
        return;
      case "video":
        canvas.fillRoundRect(x, y, w, h, radius, hexToRgba("#3a3a3a", alpha), clip);
        return;
      case "svg":
        canvas.fillRect(x, y, w, h, hexToRgba(SVG_PLACEHOLDER, alpha * 0.85), clip);
        return;
      case "line": {
        const color = fillColor(node.strokes[0]?.fills, design) ?? "#111111";
        const sw = Math.max(1, (node.strokes[0]?.width ?? 1) * scale);
        canvas.fillRect(x, y + h / 2 - sw / 2, Math.max(w, sw), sw, hexToRgba(color, alpha), clip);
        return;
      }
      case "qr": {
        canvas.fillRect(x, y, w, h, hexToRgba(node.bg, alpha), clip);
        const cells = 21;
        const cw = w / cells;
        for (let r = 0; r < cells; r++) {
          for (let c = 0; c < cells; c++) {
            const finder =
              (r < 7 && c < 7) || (r < 7 && c >= cells - 7) || (r >= cells - 7 && c < 7);
            if (finder || (r * 7 + c * 13 + r * c) % 3 === 0) {
              canvas.fillRect(x + c * cw, y + r * cw, cw, cw, hexToRgba(node.fg, alpha), clip);
            }
          }
        }
        return;
      }
      case "chart": {
        const series = node.data.series[0];
        const values = series?.values ?? [];
        const max = Math.max(1, ...values);
        const bw = w / Math.max(1, values.length * 1.5);
        values.forEach((v, i) => {
          const bh = (v / max) * h * 0.9;
          const color =
            node.options.palette[i % Math.max(1, node.options.palette.length)] ?? "#ffb02e";
          canvas.fillRect(
            x + i * bw * 1.5 + bw * 0.25,
            y + h - bh,
            bw,
            bh,
            hexToRgba(color, alpha),
            clip,
          );
        });
        return;
      }
      case "table": {
        canvas.fillRect(x, y, w, h, hexToRgba("#ffffff", alpha), clip);
        let cy = y;
        for (const rh of node.rowHeights) {
          canvas.fillRect(
            x,
            cy,
            w,
            Math.max(1, node.borderWidth * scale),
            hexToRgba(node.borderColor, alpha),
            clip,
          );
          cy += rh * scale;
        }
        return;
      }
      default:
        break;
    }
    if ("fills" in node) {
      const color = fillColor(node.fills, design);
      const hasImageFill = node.fills.some((f) => f.type === "image" && f.visible !== false);
      const paint = color ?? (hasImageFill ? IMAGE_PLACEHOLDER : undefined);
      if (paint) {
        const rgba = hexToRgba(paint, alpha);
        if (node.type === "ellipse") canvas.fillEllipse(x, y, w, h, rgba, clip);
        else canvas.fillRoundRect(x, y, w, h, radius, rgba, clip);
      }
      const stroke = node.strokes.find((s) => s.visible !== false);
      const strokeColor = stroke ? fillColor(stroke.fills, design) : undefined;
      if (stroke && strokeColor && node.type !== "ellipse") {
        const sw = Math.max(1, stroke.width * scale);
        const c = hexToRgba(strokeColor, alpha);
        canvas.fillRect(x, y, w, sw, c, clip);
        canvas.fillRect(x, y + h - sw, w, sw, c, clip);
        canvas.fillRect(x, y, sw, h, c, clip);
        canvas.fillRect(x + w - sw, y, sw, h, c, clip);
      }
    }
    if ("children" in node && node.type !== "root") {
      const childClip = "clip" in node && node.clip ? intersectClip({ x, y, w, h }, clip) : clip;
      for (const child of childNodes(design, node.id)) paintNode(child, alpha, childClip);
    }
  };

  for (const child of childNodes(design, page.id))
    paintNode(child, 1, { x: 0, y: 0, w: width, h: height });
  return { bytes: encodePng(width, height, canvas.data), mime: "image/png", width, height };
}
