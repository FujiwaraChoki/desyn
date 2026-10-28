import {
  createDesign,
  createGroup,
  createRect,
  type Design,
  type Id,
  type Node,
} from "@desyn/schema";

/** Test designs built without importing the editor's extensions (keeps these suites independent). */
export function pageIdOf(d: Design): Id {
  return (d.nodes.root as Node & { children: Id[] }).children[0] as Id;
}

export function withNodes(design: Design, parent: Id, nodes: Node[]): Design {
  const p = design.nodes[parent] as Node & { children: Id[] };
  const next = {
    ...design.nodes,
    [parent]: {
      ...p,
      children: [...p.children, ...nodes.filter((n) => n.parent === parent).map((n) => n.id)],
    } as Node,
  };
  for (const n of nodes) next[n.id] = n;
  return { ...design, nodes: next };
}

/** A page with three rects and a rotated group (with two rects inside). */
export function fixture() {
  let design = createDesign("social-post");
  const page = pageIdOf(design);
  const a = createRect({ parent: page, name: "A", x: 10, y: 10, width: 100, height: 50 });
  const b = createRect({ parent: page, name: "B", x: 200, y: 100, width: 80, height: 80 });
  const c = createRect({ parent: page, name: "C", x: 400, y: 300, width: 60, height: 40 });
  const g = createGroup({
    parent: page,
    name: "G",
    x: 500,
    y: 500,
    width: 100,
    height: 100,
    rotation: 30,
  });
  const g1 = createRect({ parent: g.id, name: "G1", x: 0, y: 0, width: 50, height: 50 });
  const g2 = createRect({ parent: g.id, name: "G2", x: 50, y: 50, width: 50, height: 50 });
  design = withNodes(design, page, [a, b, c, g]);
  design = withNodes(design, g.id, [g1, g2]);
  return { design, page, a: a.id, b: b.id, c: c.id, g: g.id, g1: g1.id, g2: g2.id };
}
