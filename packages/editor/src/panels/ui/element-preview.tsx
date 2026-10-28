"use client";

import type { PreviewSpec } from "../lib/catalog.ts";

/** 48 x 48 vector previews of catalog entries, drawn in the current text color with a sun tint. */
export function ElementPreview({ spec, size = 40 }: { spec: PreviewSpec; size?: number }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden
      className="text-fg-secondary transition-colors duration-200 group-hover/tile:text-accent"
    >
      <Shape spec={spec} />
    </svg>
  );
}

function Shape({ spec }: { spec: PreviewSpec }) {
  const fill = "currentColor";
  switch (spec.kind) {
    case "rect": {
      const ratio = spec.ratio ?? 1;
      const w = ratio >= 1 ? 36 : 36 * ratio;
      const h = ratio >= 1 ? 36 / ratio : 36;
      return (
        <rect
          x={24 - w / 2}
          y={24 - h / 2}
          width={w}
          height={h}
          rx={spec.radius ?? 0}
          fill={fill}
        />
      );
    }
    case "ellipse":
      return <circle cx={24} cy={24} r={18} fill={fill} />;
    case "path":
      return <path d={spec.d} fill={fill} fillRule="evenodd" />;
    case "line": {
      const x1 = spec.start === "none" ? 6 : 10;
      const x2 = spec.end === "none" ? 42 : 38;
      return (
        <g stroke={fill} strokeWidth={2.5} strokeLinecap="round" fill="none">
          <line x1={x1} y1={24} x2={x2} y2={24} strokeDasharray={spec.dash ? "4 4" : undefined} />
          {cap(spec.end, 42, 1)}
          {cap(spec.start, 6, -1)}
        </g>
      );
    }
    case "frame": {
      const w = spec.ratio >= 1 ? 38 : 38 * spec.ratio;
      const h = spec.ratio >= 1 ? 38 / spec.ratio : 38;
      const x = 24 - w / 2;
      const y = 24 - h / 2;
      const r = spec.radius;
      const d = Array.isArray(r)
        ? roundedPath(
            x,
            y,
            w,
            h,
            r.map((v) => Math.min(v, w / 2, h / 2)) as [number, number, number, number],
          )
        : roundedPath(
            x,
            y,
            w,
            h,
            [r, r, r, r].map((v) => Math.min(v, w / 2, h / 2)) as [number, number, number, number],
          );
      return (
        <g>
          <path d={d} fill={fill} opacity={0.18} />
          <path d={d} fill="none" stroke={fill} strokeWidth={1.5} strokeDasharray="3 2.5" />
          <path d={`M${24 - 7} ${24 + 5} l5 -6 l4 4 l3 -3 l5 5 Z`} fill={fill} opacity={0.8} />
          <circle cx={24 + 4} cy={24 - 5} r={2} fill={fill} opacity={0.8} />
        </g>
      );
    }
    case "grid": {
      const cells = [];
      const w = (40 - spec.gap * (spec.cols - 1)) / spec.cols;
      const h = Math.min(w, (40 - spec.gap * (spec.rows - 1)) / spec.rows);
      const totalH = h * spec.rows + spec.gap * (spec.rows - 1);
      const y0 = 24 - totalH / 2;
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
          cells.push(
            <rect
              key={`${r}-${c}`}
              x={4 + c * (w + spec.gap)}
              y={y0 + r * (h + spec.gap)}
              width={w}
              height={h}
              rx={1.5}
              fill={fill}
              opacity={0.75}
            />,
          );
        }
      }
      return <g>{cells}</g>;
    }
  }
}

function cap(kind: string, x: number, dir: 1 | -1) {
  switch (kind) {
    case "arrow":
      return <path d={`M${x - dir * 7} 17 L${x} 24 L${x - dir * 7} 31`} />;
    case "triangle":
      return <path d={`M${x - dir * 8} 18 L${x} 24 L${x - dir * 8} 30 Z`} fill="currentColor" />;
    case "circle":
      return <circle cx={x - dir * 3} cy={24} r={3.5} fill="currentColor" />;
    default:
      return null;
  }
}

function roundedPath(
  x: number,
  y: number,
  w: number,
  h: number,
  [tl, tr, br, bl]: [number, number, number, number],
) {
  return [
    `M${x + tl} ${y}`,
    `L${x + w - tr} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + tr}`,
    `L${x + w} ${y + h - br}`,
    `Q${x + w} ${y + h} ${x + w - br} ${y + h}`,
    `L${x + bl} ${y + h}`,
    `Q${x} ${y + h} ${x} ${y + h - bl}`,
    `L${x} ${y + tl}`,
    `Q${x} ${y} ${x + tl} ${y}`,
    "Z",
  ].join(" ");
}
