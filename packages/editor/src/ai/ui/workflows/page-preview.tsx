"use client";

import type { Design, Fill, Id, Node } from "@desyn/schema";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { EditorController } from "../../../controller.ts";

/**
 * A light SVG rendering of one page for workflow previews (magic resize reflow, bulk rows). It draws the real
 * geometry, fills, text and images of the (possibly reflowed) design so the user sees where every layer
 * lands; it is not the engine's pixel-exact render, which the workflow produces on the server.
 */

function solid(design: Design, fills: readonly Fill[] | undefined): string | null {
  for (const f of [...(fills ?? [])].reverse()) {
    if (f.visible === false) continue;
    if (f.type === "solid") return resolve(design, f.color);
    if (f.type === "linear" || f.type === "radial" || f.type === "conic") {
      const stop = f.stops[Math.floor(f.stops.length / 2)];
      if (stop) return resolve(design, stop.color);
    }
  }
  return null;
}

function resolve(design: Design, color: unknown): string | null {
  if (typeof color === "string") return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color) ? color : null;
  if (color && typeof color === "object") {
    const ref = color as { $var?: string; $style?: string };
    if (ref.$var) return resolve(design, design.styles.variables[ref.$var]);
    if (ref.$style) return resolve(design, design.styles.colors[ref.$style]?.value);
  }
  return null;
}

function imageFill(fills: readonly Fill[] | undefined): Id | null {
  const f = fills?.find((x) => x.type === "image" && x.visible !== false);
  return f && f.type === "image" ? f.assetId : null;
}

/** Signed URLs of the design's image / SVG assets (resolved once per asset). */
/**
 * The design's family first, then a generic family of the same kind: design fonts are loaded into the engine,
 * not always into this document, and the browser default (a Times-like serif) misrepresents sans designs.
 */
function withFallback(family: string): string {
  const generic = /serif|garamond|baskerville|times|georgia|playfair|bodoni|didot/i.test(family)
    ? /sans/i.test(family)
      ? "sans-serif"
      : "serif"
    : /mono|code/i.test(family)
      ? "monospace"
      : "sans-serif";
  return `"${family.replace(/"/g, "")}", ${generic}`;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Text width in px with the browser's metrics for `font` (CSS shorthand); null where canvas text is missing. */
function measure(font: string, text: string): number | null {
  if (measureCtx === undefined) {
    try {
      measureCtx =
        typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return null;
  measureCtx.font = font;
  const w = measureCtx.measureText(text).width;
  return Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * Greedy word wrap to `width` px (explicit line breaks kept). Uses canvas metrics of the same font stack the
 * SVG draws with; without them, an average advance of half the font size.
 */
function wrapLines(text: string, width: number, font: string, size: number): string[] {
  const fits = (line: string) => (measure(font, line) ?? line.length * size * 0.5) <= width;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && !fits(`${line} ${word}`)) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

export function useAssetUrls(editor: EditorController, design: Design | null): Record<Id, string> {
  const [urls, setUrls] = useState<Record<Id, string>>({});
  const ids = design
    ? Object.values(design.assets)
        .filter((a) => a.kind === "image" || a.kind === "svg")
        .map((a) => a.id)
        .sort()
        .join(",")
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the asset id list
  useEffect(() => {
    if (!design || !ids) return;
    let alive = true;
    void Promise.all(
      ids.split(",").map(async (id) => {
        const ref = design.assets[id];
        const url = ref ? await editor.assets.urlFor(ref).catch(() => null) : null;
        return [id, url] as const;
      }),
    ).then((pairs) => {
      if (!alive) return;
      const out: Record<Id, string> = {};
      for (const [id, url] of pairs) if (url) out[id] = url;
      setUrls(out);
    });
    return () => {
      alive = false;
    };
  }, [editor, ids]);
  return urls;
}

function NodeShape({
  design,
  node,
  urls,
  clipPrefix,
}: {
  design: Design;
  node: Node;
  urls: Record<Id, string>;
  clipPrefix: string;
}): ReactNode {
  if (!node.visible) return null;
  const w = Math.max(0, node.width);
  const h = Math.max(0, node.height);
  const transform = `translate(${node.x} ${node.y})${node.rotation ? ` rotate(${node.rotation} ${w / 2} ${h / 2})` : ""}`;
  const radius =
    "cornerRadius" in node && typeof node.cornerRadius === "number" ? node.cornerRadius : 0;
  let body: ReactNode = null;
  switch (node.type) {
    case "rect":
    case "frame":
    case "polygon":
    case "star":
    case "boolean": {
      const fill = solid(design, node.fills);
      const img = imageFill(node.fills);
      body = (
        <>
          {fill ? <rect width={w} height={h} rx={radius} fill={fill} /> : null}
          {img && urls[img] ? (
            <image href={urls[img]} width={w} height={h} preserveAspectRatio="xMidYMid slice" />
          ) : null}
        </>
      );
      break;
    }
    case "ellipse": {
      const fill = solid(design, node.fills);
      body = fill ? <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} /> : null;
      break;
    }
    case "path": {
      const fill = solid(design, node.fills);
      const stroke = solid(design, node.strokes[0]?.fills);
      body = node.paths.map((p, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: path order is the node's own
          key={i}
          d={p.d}
          fillRule={p.fillRule}
          fill={fill ?? "none"}
          stroke={stroke ?? undefined}
          strokeWidth={node.strokes[0]?.width}
        />
      ));
      break;
    }
    case "line": {
      const stroke = solid(design, node.strokes[0]?.fills) ?? "#888888";
      body = (
        <line
          x1={0}
          y1={0}
          x2={w}
          y2={0}
          stroke={stroke}
          strokeWidth={node.strokes[0]?.width ?? 2}
        />
      );
      break;
    }
    case "text": {
      const size = node.style.fontSize;
      const color = solid(design, node.style.fills) ?? "#888888";
      const raw = node.runs.map((r) => r.text).join("");
      const lines = (
        node.autoResize === "width"
          ? raw.split("\n")
          : wrapLines(
              raw,
              w,
              `${node.style.fontStyle === "italic" ? "italic " : ""}${node.style.fontWeight} ${size}px ${withFallback(node.style.fontFamily)}`,
              size,
            )
      ).slice(0, 12);
      const lh =
        node.paragraph.lineHeight.unit === "px" ? node.paragraph.lineHeight.value : size * 1.2;
      const anchor =
        node.paragraph.align === "center"
          ? "middle"
          : node.paragraph.align === "right"
            ? "end"
            : "start";
      const x = anchor === "middle" ? w / 2 : anchor === "end" ? w : 0;
      body = (
        <text
          fontFamily={withFallback(node.style.fontFamily)}
          fontSize={size}
          fontWeight={node.style.fontWeight}
          fontStyle={node.style.fontStyle}
          fill={color}
          textAnchor={anchor}
        >
          {lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of one text node
            <tspan key={i} x={x} y={size * 0.92 + i * lh}>
              {node.style.textCase === "upper" ? l.toUpperCase() : l}
            </tspan>
          ))}
        </text>
      );
      break;
    }
    case "image": {
      const url = urls[node.assetId];
      const ratio =
        node.fit === "fit" ? "xMidYMid meet" : node.fit === "fill" ? "none" : "xMidYMid slice";
      body = url ? (
        <image href={url} width={w} height={h} preserveAspectRatio={ratio} />
      ) : (
        <rect width={w} height={h} rx={radius} fill="currentColor" opacity={0.12} />
      );
      break;
    }
    case "svg": {
      const url = node.assetId
        ? urls[node.assetId]
        : node.markup
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.markup)}`
          : undefined;
      body = url ? <image href={url} width={w} height={h} /> : null;
      break;
    }
    case "chart":
    case "table":
    case "qr":
    case "video":
      body = <rect width={w} height={h} rx={4} fill="currentColor" opacity={0.1} />;
      break;
    default:
      break;
  }
  const children =
    "children" in node && node.type !== "page" && node.type !== "root"
      ? (node.children as Id[]).map((id) => {
          const child = design.nodes[id];
          return child ? (
            <NodeShape key={id} design={design} node={child} urls={urls} clipPrefix={clipPrefix} />
          ) : null;
        })
      : null;
  const clip = node.type === "frame" && node.clip ? `${clipPrefix}-${node.id}` : null;
  return (
    <g transform={transform} opacity={node.opacity < 1 ? node.opacity : undefined}>
      {clip ? (
        <clipPath id={clip}>
          <rect width={w} height={h} rx={radius} />
        </clipPath>
      ) : null}
      {body}
      {children ? <g clipPath={clip ? `url(#${clip})` : undefined}>{children}</g> : null}
    </g>
  );
}

export function PagePreview({
  design,
  pageId,
  urls,
  className,
  label,
}: {
  design: Design;
  pageId: Id;
  urls: Record<Id, string>;
  className?: string;
  label: string;
}) {
  const clipPrefix = useId().replace(/:/g, "");
  const page = design.nodes[pageId];
  if (page?.type !== "page") return null;
  const bg = solid(design, page.background) ?? "#ffffff";
  const bgImage = imageFill(page.background);
  return (
    <svg
      viewBox={`0 0 ${page.width} ${page.height}`}
      className={className}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
    >
      <clipPath id={`${clipPrefix}-page`}>
        <rect width={page.width} height={page.height} />
      </clipPath>
      <g clipPath={`url(#${clipPrefix}-page)`} className="text-fg">
        <rect width={page.width} height={page.height} fill={bg} />
        {bgImage && urls[bgImage] ? (
          <image
            href={urls[bgImage]}
            width={page.width}
            height={page.height}
            preserveAspectRatio="xMidYMid slice"
          />
        ) : null}
        {page.children.map((id) => {
          const n = design.nodes[id];
          return n ? (
            <NodeShape key={id} design={design} node={n} urls={urls} clipPrefix={clipPrefix} />
          ) : null;
        })}
      </g>
    </svg>
  );
}
