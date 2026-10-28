import { Builder, descendants, scaledProps } from "@desyn/doc-ops";
import type { Design, Id, Node, Op } from "@desyn/schema";

/**
 * Geometry edits from the inspector's numeric fields. Values are in the node's parent space (like Figma's
 * X / Y), groups keep fitting their children, groups scale their content, paths and tables scale their
 * data, and fixed-size text switches to fixed width when its width is set.
 */

const r = (n: number) => Math.round(n * 100) / 100;

export function positionOps(
  design: Design,
  ids: readonly Id[],
  pos: { x?: number; y?: number },
): Op[] {
  const b = new Builder(design);
  for (const id of ids) {
    const n = design.nodes[id];
    if (!n || n.type === "page" || n.locked) continue;
    b.update(id, {
      ...(pos.x !== undefined ? { x: r(pos.x) } : {}),
      ...(pos.y !== undefined ? { y: r(pos.y) } : {}),
    });
  }
  b.refitGroups(ids);
  return b.ops;
}

const wrapDegrees = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Sets the rotation of every node (about its center); `relative` adds to each node's own rotation. */
export function rotationOps(
  design: Design,
  ids: readonly Id[],
  degrees: number,
  relative = false,
): Op[] {
  const b = new Builder(design);
  for (const id of ids) {
    const n = design.nodes[id];
    if (!n || n.type === "page" || n.locked) continue;
    b.update(id, { rotation: r(wrapDegrees(relative ? n.rotation + degrees : degrees)) });
  }
  b.refitGroups(ids);
  return b.ops;
}

function scaleSubtree(b: Builder, design: Design, root: Node, sx: number, sy: number): void {
  const k = Math.sqrt(Math.abs(sx * sy));
  for (const d of descendants(design, root.id)) {
    b.update(d.id, scaledProps(d, sx, sy, k, true));
  }
}

/**
 * Width / height for each node. `keepAspect` derives the other side from the node's own ratio (per node,
 * so a multi-selection keeps every shape's proportions).
 */
export function sizeOps(
  design: Design,
  ids: readonly Id[],
  size: { width?: number; height?: number },
  keepAspect: boolean,
): Op[] {
  const b = new Builder(design);
  for (const id of ids) {
    const n = design.nodes[id];
    if (!n || n.type === "page" || n.locked) continue;
    const ratio = n.width / Math.max(n.height, 1e-6);
    let w = size.width ?? n.width;
    let h = size.height ?? n.height;
    if (keepAspect && n.height > 0) {
      if (size.width !== undefined && size.height === undefined) h = w / ratio;
      if (size.height !== undefined && size.width === undefined) w = h * ratio;
    }
    w = Math.max(n.type === "line" ? 0 : 1, r(w));
    h = n.type === "line" ? n.height : Math.max(1, r(h));
    if (w === n.width && h === n.height) continue;
    const sx = n.width > 0 ? w / n.width : 1;
    const sy = n.height > 0 ? h / n.height : 1;
    if (n.type === "group" || n.type === "boolean") {
      scaleSubtree(b, design, n, sx, sy);
      b.update(id, { width: w, height: h });
      continue;
    }
    if (n.type === "path" || n.type === "table") {
      b.update(id, { ...scaledProps(n, sx, sy, 1, false), width: w, height: h });
      continue;
    }
    if (n.type === "text") {
      // A width typed for auto-width text fixes the width; height stays derived.
      const set: Record<string, unknown> = { width: w };
      if (n.autoResize === "width") set.autoResize = "height";
      if (size.height !== undefined || n.autoResize === "none") {
        set.height = h;
        set.autoResize = "none";
      }
      b.update(id, set);
      continue;
    }
    b.update(id, { width: w, height: h });
  }
  b.refitGroups(ids);
  return b.ops;
}
