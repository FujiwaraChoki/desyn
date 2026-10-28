// Seeded random designs, mutations and op lists for property tests.
import {
  createDesign,
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createPage,
  createRect,
  createText,
  type Design,
  type Id,
  isContainerType,
  type Node,
  type Op,
  ROOT_ID,
} from "@desyn/schema";

export type Rng = () => number;

/** mulberry32 */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, items: readonly T[]): T =>
  items[Math.floor(r() * items.length)] as T;
export const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Deterministic ids from a counter: "t" + 11 digits. */
export function idGen(prefix = "t") {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(11 - (prefix.length - 1), "0")}`;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const ASSET = "asset0000001";

function leaf(r: Rng, id: Id, parent: Id): Node {
  const common = {
    id,
    parent,
    x: int(r, -50, 900),
    y: int(r, -50, 900),
    width: int(r, 1, 400),
    height: int(r, 1, 400),
    rotation: pick(r, [0, 0, 0, 15, -30, 90, 180]),
  };
  switch (int(r, 0, 3)) {
    case 0:
      return createRect({ ...common, name: `Rect ${id}` });
    case 1:
      return createEllipse({ ...common, name: `Ellipse ${id}` });
    case 2:
      return createText({ ...common, name: `Text ${id}`, text: `Text ${id}`, autoResize: "none" });
    default:
      return createImage({ ...common, name: `Image ${id}`, assetId: ASSET });
  }
}

function container(r: Rng, id: Id, parent: Id): Node {
  const common = {
    id,
    parent,
    x: int(r, 0, 500),
    y: int(r, 0, 500),
    width: int(r, 50, 500),
    height: int(r, 50, 500),
  };
  return r() < 0.5
    ? createFrame({ ...common, name: `Frame ${id}` })
    : createGroup({ ...common, name: `Group ${id}` });
}

function addChildren(d: Design, r: Rng, next: () => Id, parent: Id, depth: number) {
  const count = int(r, 0, depth === 0 ? 6 : 3);
  for (let i = 0; i < count; i++) {
    const id = next();
    const node = depth < 2 && r() < 0.3 ? container(r, id, parent) : leaf(r, id, parent);
    d.nodes[id] = node;
    (d.nodes[parent] as { children: Id[] }).children.push(id);
    if (isContainerType(node.type)) addChildren(d, r, next, id, depth + 1);
  }
}

export function randomDesign(seed: number): Design {
  const r = rng(seed);
  const next = idGen("n");
  const d = createDesign("social-post", "instagram-post", {
    id: "dsn000000001",
    pageId: next(),
    now: 0,
  });
  d.assets[ASSET] = { id: ASSET, kind: "image", mime: "image/png", width: 100, height: 100 };
  d.styles.colors.color0000001 = { name: "Sun", value: "#ffb02e" };
  d.styles.variables["brand.primary"] = "#ffb02e";
  const pages = int(r, 1, 3);
  for (let p = 1; p < pages; p++) {
    const page = createPage({ id: next(), name: `Page ${p + 1}` });
    d.nodes[page.id] = page;
    (d.nodes[ROOT_ID] as { children: Id[] }).children.push(page.id);
  }
  for (const pageId of (d.nodes[ROOT_ID] as { children: Id[] }).children)
    addChildren(d, r, next, pageId, 0);
  return d;
}

const kids = (d: Design, id: Id): Id[] => (d.nodes[id] as { children: Id[] }).children;

function subtreeIds(d: Design, id: Id): Id[] {
  const out = [id];
  for (const c of (d.nodes[id] as { children?: Id[] }).children ?? [])
    out.push(...subtreeIds(d, c));
  return out;
}

function containersOf(d: Design, exclude: Set<Id> = new Set()): Id[] {
  return Object.values(d.nodes)
    .filter((n) => isContainerType(n.type) && n.type !== "root" && !exclude.has(n.id))
    .map((n) => n.id);
}

function shuffle<T>(r: Rng, items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** A valid design derived from `a` by direct JSON edits (independent of the applier). */
export function mutate(a: Design, seed: number, steps = 8): Design {
  const r = rng(seed);
  const d = clone(a);
  const next = idGen(`m${seed % 10}`);
  for (let s = 0; s < steps; s++) {
    const nonRoot = Object.keys(d.nodes).filter((id) => id !== ROOT_ID);
    const nonPage = nonRoot.filter((id) => d.nodes[id]?.type !== "page");
    switch (int(r, 0, 11)) {
      case 0: {
        // delete a subtree (keep at least one page)
        const id = pick(r, nonRoot);
        if (!id || (d.nodes[id]?.type === "page" && kids(d, ROOT_ID).length < 2)) break;
        const parent = d.nodes[id]?.parent as Id;
        kids(d, parent).splice(kids(d, parent).indexOf(id), 1);
        for (const sub of subtreeIds(d, id)) delete d.nodes[sub];
        break;
      }
      case 1: {
        // reparent
        const id = pick(r, nonPage);
        if (!id) break;
        const targets = containersOf(d, new Set(subtreeIds(d, id)));
        const target = pick(r, targets);
        if (!target) break;
        const parent = d.nodes[id]?.parent as Id;
        kids(d, parent).splice(kids(d, parent).indexOf(id), 1);
        kids(d, target).splice(int(r, 0, kids(d, target).length), 0, id);
        (d.nodes[id] as Node).parent = target;
        break;
      }
      case 2: {
        // shuffle children of a container (or pages)
        const c = pick(r, [ROOT_ID, ...containersOf(d)]);
        const node = d.nodes[c] as { children: Id[] };
        node.children = shuffle(r, node.children);
        break;
      }
      case 3: {
        // property edits
        const id = pick(r, nonRoot);
        if (!id) break;
        const n = d.nodes[id] as unknown as Record<string, unknown>;
        n.x = int(r, 0, 1000);
        n.name = `Edited ${s}`;
        if (r() < 0.5) n.opacity = Math.round(r() * 100) / 100;
        if (r() < 0.3) n.alt = "alt text";
        else delete n.alt;
        if (r() < 0.2) n.futureKey = { s };
        break;
      }
      case 4: {
        // new subtree
        const parent = pick(r, containersOf(d));
        if (!parent) break;
        const id = next();
        const isContainer = r() < 0.4;
        const node = isContainer ? container(r, id, parent) : leaf(r, id, parent);
        d.nodes[id] = node;
        kids(d, parent).splice(int(r, 0, kids(d, parent).length), 0, id);
        if (isContainer) addChildren(d, r, next, id, 1);
        break;
      }
      case 5: {
        // retype a leaf, or a container to the other container type (children kept)
        const id = pick(r, nonPage);
        if (!id) break;
        const old = d.nodes[id] as Node;
        const base = {
          id,
          parent: old.parent as Id,
          x: old.x,
          y: old.y,
          width: old.width,
          height: old.height,
          name: old.name,
        };
        if (old.type === "frame") d.nodes[id] = createGroup({ ...base, children: kids(d, id) });
        else if (old.type === "group")
          d.nodes[id] = createFrame({ ...base, children: kids(d, id) });
        else d.nodes[id] = old.type === "rect" ? createEllipse(base) : createRect(base);
        break;
      }
      case 6: {
        // new page with content
        const page = createPage({ id: next(), name: "New page" });
        d.nodes[page.id] = page;
        kids(d, ROOT_ID).splice(int(r, 0, kids(d, ROOT_ID).length), 0, page.id);
        addChildren(d, r, next, page.id, 1);
        break;
      }
      case 7: {
        // move a node into a brand-new frame (survivor under a new parent)
        const id = pick(r, nonPage);
        if (!id) break;
        const parent = d.nodes[id]?.parent as Id;
        const fid = next();
        d.nodes[fid] = createFrame({ id: fid, parent, children: [id] });
        kids(d, parent).splice(kids(d, parent).indexOf(id), 1, fid);
        (d.nodes[id] as Node).parent = fid;
        break;
      }
      case 8: {
        d.name = `Renamed ${s}`;
        if (r() < 0.5) d.brandKitId = `kit_${s}`;
        else delete d.brandKitId;
        d.meta = { ...d.meta, updatedAt: s };
        break;
      }
      case 9: {
        if (r() < 0.5)
          d.assets[`as${String(s).padStart(10, "0")}`] = {
            id: `as${String(s).padStart(10, "0")}`,
            kind: "svg",
            mime: "image/svg+xml",
          };
        else delete d.assets.asset0000001;
        break;
      }
      case 10: {
        if (r() < 0.5)
          d.styles.colors[`cs${String(s).padStart(10, "0")}`] = { name: `C${s}`, value: "#123456" };
        else d.styles.colors = {};
        d.styles.variables[`v${s}`] = s;
        if (r() < 0.3) delete d.styles.variables["brand.primary"];
        break;
      }
      default: {
        // retype a container whose children survive under the new incarnation, then shuffle them
        const frames = Object.values(d.nodes).filter(
          (n) => n.type === "frame" || n.type === "group",
        );
        const f = pick(r, frames);
        if (!f) break;
        const base = {
          id: f.id,
          parent: f.parent as Id,
          name: f.name,
          children: shuffle(r, kids(d, f.id)),
        };
        d.nodes[f.id] = f.type === "frame" ? createGroup(base) : createFrame(base);
      }
    }
  }
  return d;
}

/** Random op list mixing valid and invalid ops against `d`. */
export function randomOps(d: Design, seed: number, count = 10): Op[] {
  const r = rng(seed);
  const next = idGen(`o${seed % 10}`);
  const ids = [...Object.keys(d.nodes), "missing00001"];
  const containers = [
    ...Object.values(d.nodes)
      .filter((n) => isContainerType(n.type))
      .map((n) => n.id),
    "missing00002",
  ];
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const id = pick(r, ids);
    switch (int(r, 0, 7)) {
      case 0: {
        const parent = pick(r, containers);
        const nid = next();
        const node =
          parent === ROOT_ID
            ? createPage({ id: nid })
            : r() < 0.3
              ? createFrame({ id: nid, parent })
              : leaf(r, nid, parent);
        ops.push({ op: "create", nodes: [node], parent, index: int(r, -2, 8) });
        ids.push(nid);
        if (isContainerType(node.type)) containers.push(nid);
        break;
      }
      case 1:
        ops.push({
          op: "update",
          id,
          set: { name: `N${i}`, x: int(r, -10, 10), ...(r() < 0.1 ? { opacity: 3 } : {}) },
        });
        break;
      case 2:
        ops.push({ op: "update", id, unset: [pick(r, ["alt", "role", "opacity", "futureKey"])] });
        break;
      case 3:
        ops.push({
          op: "patch",
          id,
          path: pick(r, [
            ["name"],
            ["fills", 0, "color"],
            ["fills", 1],
            ["style", "fontSize"],
            ["meta", "x"],
            ["futureKey"],
          ]),
          value: pick(r, ["#abcdef", 12, { type: "solid", color: "#000000" }, "text"]),
        });
        break;
      case 4:
        ops.push({ op: "delete", id });
        break;
      case 5:
        ops.push({
          op: "move",
          id,
          parent: pick(r, containers),
          ...(r() < 0.7 ? { index: int(r, -1, 6) } : {}),
        });
        break;
      case 6:
        ops.push(
          r() < 0.5
            ? { op: "styles", path: ["variables", `k${i}`], value: i }
            : {
                op: "asset",
                set: {
                  [`as${String(i).padStart(10, "0")}`]: {
                    id: `as${String(i).padStart(10, "0")}`,
                    kind: "image",
                    mime: "image/png",
                  },
                },
                remove: ["asset0000001"],
              },
        );
        break;
      default:
        ops.push({
          op: "doc",
          set: { name: `D${i}` },
          ...(r() < 0.3 ? { unset: ["brandKitId"] as "brandKitId"[] } : {}),
        });
    }
  }
  return ops;
}
