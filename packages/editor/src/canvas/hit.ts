import { getNode } from "@desyn/doc-ops";
import type { Design, Id, Node } from "@desyn/schema";
import { isContainerNode, nodeObb } from "./geometry.ts";
import { obbContains, type Point } from "./math.ts";

/**
 * Box-based hit path (page child first, deepest last), used before the engine is up and in tests. The engine's
 * hit test is exact (shapes, strokes, clipping, masks); this one tests node boxes, honoring visibility, locks
 * and clipping containers.
 */
export function localHitPath(design: Design, pageId: Id, p: Point, tolerance = 0): Id[] {
  const page = getNode(design, pageId);
  if (!isContainerNode(page)) return [];
  const path: Id[] = [];
  const visit = (container: Node & { children: Id[] }): boolean => {
    for (let i = container.children.length - 1; i >= 0; i--) {
      const id = container.children[i] as Id;
      const node = getNode(design, id);
      if (!node?.visible || node.locked || node.mask) continue;
      const box = nodeObb(design, id);
      if (!box) continue;
      const inside = obbContains(box, p, tolerance);
      if (isContainerNode(node) && node.type !== "boolean") {
        const clips = "clip" in node && node.clip;
        if (clips && !inside) continue;
        path.push(id);
        if (visit(node)) return true;
        // Frames are hit on their own area; groups only through their children.
        if (node.type === "frame" && inside) return true;
        path.pop();
        continue;
      }
      if (inside) {
        path.push(id);
        return true;
      }
    }
    return false;
  };
  visit(page);
  return path;
}
