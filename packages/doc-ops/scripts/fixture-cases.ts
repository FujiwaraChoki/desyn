// Hand-written conformance cases. Each case states its expected outcome independently of the implementation:
// `after` mutates a deep copy of `before` by hand, `applied` / `dropped` are written out. gen-fixtures.ts checks the
// TS applier against these expectations before writing spec/fixtures/ops/*.json.
import {
  createAudio,
  createBoolean,
  createChart,
  createEllipse,
  createGroup,
  createImage,
  createLine,
  createPage,
  createPath,
  createPolygon,
  createQr,
  createStar,
  createSvg,
  createTable,
  createVideo,
  type Design,
  type DropReason,
  type Node,
} from "@desyn/schema";
import {
  ASSET,
  BG,
  baseDesign,
  COLOR_STYLE,
  ELL,
  FRAME,
  FRECT,
  FTEXT,
  FX_STYLE,
  frame,
  GELL,
  GRECT,
  GROUP,
  IMG,
  N,
  P1,
  P2,
  P2RECT,
  P2TEXT,
  rect,
  TEXT,
  TEXT_STYLE,
  text,
} from "./fixture-base";

// biome-ignore lint/suspicious/noExplicitAny: fixture expectations poke at arbitrary JSON.
type Any = any;

export interface Case {
  name: string;
  description: string;
  before?: Design;
  ops: unknown[];
  dropped?: { index: number; reason: DropReason }[];
  /** Expected `applied`; default: the input ops that are not dropped, unchanged. */
  applied?: unknown[];
  /** Hand-computed mutation of a deep copy of `before`; default: no change. */
  after?: (d: Any) => void;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const kids = (d: Any, id: string): string[] => d.nodes[id].children;

function add(d: Any, ...nodes: Node[]) {
  for (const n of nodes) d.nodes[n.id] = clone(n);
}
function insert(d: Any, parent: string, id: string, index?: number) {
  const c = kids(d, parent);
  c.splice(index ?? c.length, 0, id);
}
function removeSubtree(d: Any, id: string) {
  const n = d.nodes[id];
  const c = kids(d, n.parent);
  c.splice(c.indexOf(id), 1);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    stack.push(...(d.nodes[cur].children ?? []));
    delete d.nodes[cur];
  }
}
function moveTo(d: Any, id: string, parent: string, index?: number) {
  const n = d.nodes[id];
  const from = kids(d, n.parent);
  from.splice(from.indexOf(id), 1);
  insert(d, parent, id, index);
  n.parent = parent;
}

function design(mutate: (d: Any) => void): Design {
  const d = baseDesign() as Any;
  mutate(d);
  return d;
}

const P1_LEN = 6;
const r1 = rect(N(1), P1);
const r2 = rect(N(2), N(1));

export const CASES: Case[] = [
  // ------------------------------------------------------------------------------------------------- create
  {
    name: "create-rect-append",
    description:
      "create without index appends on top of the parent; applied gets the explicit index",
    ops: [{ op: "create", nodes: [r1], parent: P1 }],
    applied: [{ op: "create", nodes: [r1], parent: P1, index: P1_LEN }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-rect-index-0",
    description: "index 0 inserts at the bottom of the z-order",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: 0 }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1), 0);
    },
  },
  {
    name: "create-rect-index-middle",
    description: "index 3 inserts before the current element at 3",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: 3 }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1), 3);
    },
  },
  {
    name: "create-index-equals-length",
    description: "index == children.length is the top",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: P1_LEN }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-index-clamp-high",
    description: "index past the end clamps to children.length",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: 99 }],
    applied: [{ op: "create", nodes: [r1], parent: P1, index: P1_LEN }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-index-clamp-negative",
    description: "negative index clamps to 0",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: -5 }],
    applied: [{ op: "create", nodes: [r1], parent: P1, index: 0 }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1), 0);
    },
  },
  {
    name: "create-parent-field-overwritten",
    description: "nodes[0].parent is overwritten with the op's parent",
    ops: [{ op: "create", nodes: [rect(N(1), P2RECT)], parent: P1, index: 1 }],
    applied: [{ op: "create", nodes: [r1], parent: P1, index: 1 }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1), 1);
    },
  },
  {
    name: "create-into-frame",
    description: "create inside a frame at index 1",
    ops: [{ op: "create", nodes: [rect(N(1), FRAME)], parent: FRAME, index: 1 }],
    after: (d) => {
      add(d, rect(N(1), FRAME));
      insert(d, FRAME, N(1), 1);
    },
  },
  {
    name: "create-subtree-frame",
    description: "nodes[1..] are descendants of nodes[0]; all land in the map",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, [N(2), N(3)]), rect(N(2), N(1)), text(N(3), N(1), "Hello")],
        parent: P1,
        index: 2,
      },
    ],
    after: (d) => {
      add(d, frame(N(1), P1, [N(2), N(3)]), rect(N(2), N(1)), text(N(3), N(1), "Hello"));
      insert(d, P1, N(1), 2);
    },
  },
  {
    name: "create-subtree-three-levels",
    description: "frame > frame > rect created in one op",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P2, [N(2)]), frame(N(2), N(1), [N(3)]), rect(N(3), N(2))],
        parent: P2,
      },
    ],
    applied: [
      {
        op: "create",
        nodes: [frame(N(1), P2, [N(2)]), frame(N(2), N(1), [N(3)]), rect(N(3), N(2))],
        parent: P2,
        index: 2,
      },
    ],
    after: (d) => {
      add(d, frame(N(1), P2, [N(2)]), frame(N(2), N(1), [N(3)]), rect(N(3), N(2)));
      insert(d, P2, N(1));
    },
  },
  {
    name: "create-subtree-order-independent",
    description: "descendants may be listed in any order after nodes[0]",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, [N(2)]), rect(N(3), N(2)), frame(N(2), N(1), [N(3)])],
        parent: P1,
        index: 0,
      },
    ],
    after: (d) => {
      add(d, frame(N(1), P1, [N(2)]), rect(N(3), N(2)), frame(N(2), N(1), [N(3)]));
      insert(d, P1, N(1), 0);
    },
  },
  {
    name: "create-page-append",
    description: "pages are created under the root",
    ops: [{ op: "create", nodes: [createPage({ id: N(1), name: "Page 3" })], parent: "root" }],
    applied: [
      { op: "create", nodes: [createPage({ id: N(1), name: "Page 3" })], parent: "root", index: 2 },
    ],
    after: (d) => {
      add(d, createPage({ id: N(1), name: "Page 3" }));
      insert(d, "root", N(1));
    },
  },
  {
    name: "create-page-index-0",
    description: "a page inserted before the first page",
    ops: [
      { op: "create", nodes: [createPage({ id: N(1), name: "Cover" })], parent: "root", index: 0 },
    ],
    after: (d) => {
      add(d, createPage({ id: N(1), name: "Cover" }));
      insert(d, "root", N(1), 0);
    },
  },
  {
    name: "create-page-with-children",
    description: "a page subtree with content",
    ops: [
      {
        op: "create",
        nodes: [createPage({ id: N(1), name: "Page 3", children: [N(2)] }), rect(N(2), N(1))],
        parent: "root",
        index: 1,
      },
    ],
    after: (d) => {
      add(d, createPage({ id: N(1), name: "Page 3", children: [N(2)] }), rect(N(2), N(1)));
      insert(d, "root", N(1), 1);
    },
  },
  {
    name: "create-page-under-page",
    description: "pages cannot nest",
    ops: [{ op: "create", nodes: [createPage({ id: N(1) })], parent: P1 }],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "create-rect-under-root",
    description: "only pages may be children of the root",
    ops: [{ op: "create", nodes: [rect(N(1), "root")], parent: "root" }],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "create-subtree-containing-page",
    description: "a page anywhere inside a created subtree is rejected",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, [N(2)]), { ...createPage({ id: N(2) }), parent: N(1) }],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "create-missing-parent",
    description: "parent id does not exist",
    ops: [{ op: "create", nodes: [rect(N(1), N(9))], parent: N(9) }],
    dropped: [{ index: 0, reason: "missing-parent" }],
  },
  {
    name: "create-parent-not-container",
    description: "a rect cannot hold children",
    ops: [{ op: "create", nodes: [rect(N(1), ELL)], parent: ELL }],
    dropped: [{ index: 0, reason: "not-container" }],
  },
  {
    name: "create-duplicate-existing-id",
    description: "ids must be new to the design",
    ops: [{ op: "create", nodes: [rect(ELL, P1)], parent: P1 }],
    dropped: [{ index: 0, reason: "duplicate-id" }],
  },
  {
    name: "create-duplicate-id-in-batch",
    description: "ids must be unique within the op",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, [N(2)]), rect(N(2), N(1)), rect(N(2), N(1))],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "duplicate-id" }],
  },
  {
    name: "create-id-root",
    description: "the reserved id root can never be created",
    ops: [{ op: "create", nodes: [rect("root", P1)], parent: P1 }],
    dropped: [{ index: 0, reason: "duplicate-id" }],
  },
  {
    name: "create-type-root",
    description: "a second root node is rejected",
    ops: [
      {
        op: "create",
        nodes: [{ ...rect(N(1), P1), type: "root", children: [] }],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "root-protected" }],
  },
  {
    name: "create-invalid-opacity",
    description: "opacity must be within [0, 1]",
    ops: [{ op: "create", nodes: [rect(N(1), P1, { opacity: 1.5 })], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-negative-width",
    description: "width must be >= 0",
    ops: [{ op: "create", nodes: [rect(N(1), P1, { width: -1 })], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-unknown-node-type",
    description: "node types are a closed set",
    ops: [{ op: "create", nodes: [{ ...rect(N(1), P1), type: "sparkle" }], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-invalid-color",
    description: "colors are lowercase #rrggbb / #rrggbbaa",
    ops: [
      {
        op: "create",
        nodes: [rect(N(1), P1, { fills: [{ type: "solid", color: "#FFF" }] } as Partial<Node>)],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-missing-required-field",
    description: "a node without a required field (blend) is invalid",
    ops: [
      {
        op: "create",
        nodes: [
          (() => {
            const n = clone(r1) as Any;
            delete n.blend;
            return n;
          })(),
        ],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-child-not-listed",
    description: "a descendant must appear in its parent's children",
    ops: [{ op: "create", nodes: [frame(N(1), P1, []), rect(N(2), N(1))], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-child-wrong-parent",
    description: "a listed child must name the listing container as parent",
    ops: [{ op: "create", nodes: [frame(N(1), P1, [N(2)]), rect(N(2), P1)], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-child-missing-from-batch",
    description: "children must all be part of the op",
    ops: [{ op: "create", nodes: [frame(N(1), P1, [N(2)])], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-detached-cycle",
    description: "nodes not reachable from nodes[0] (here a detached two-node cycle) are rejected",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, []), frame(N(2), N(3), [N(3)]), frame(N(3), N(2), [N(2)])],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-head-listed-as-child",
    description: "nodes[0] cannot appear in another node's children",
    ops: [
      { op: "create", nodes: [frame(N(1), P1, [N(2)]), frame(N(2), N(1), [N(1)])], parent: P1 },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-non-container-with-children",
    description: "non-container nodes have no children key",
    ops: [{ op: "create", nodes: [{ ...r1, children: [] }], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-descendant-without-parent",
    description: "every descendant needs its parent field",
    ops: [
      {
        op: "create",
        nodes: [
          frame(N(1), P1, [N(2)]),
          (() => {
            const n = clone(r2) as Any;
            delete n.parent;
            return n;
          })(),
        ],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-svg-without-source",
    description: "svg nodes need assetId or markup",
    ops: [
      {
        op: "create",
        nodes: [
          (() => {
            const n = clone(createSvg({ id: N(1), parent: P1, markup: "<svg/>" })) as Any;
            delete n.markup;
            return n;
          })(),
        ],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-empty-nodes",
    description: "nodes must be a non-empty array",
    ops: [{ op: "create", nodes: [], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "create-missing-parent-field",
    description: "the op's parent is required",
    ops: [{ op: "create", nodes: [r1] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "create-fractional-index",
    description: "index must be an integer",
    ops: [{ op: "create", nodes: [r1], parent: P1, index: 1.5 }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "create-node-not-object",
    description: "every entry of nodes must be an object with a string id",
    ops: [{ op: "create", nodes: ["rect"], parent: P1 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-preserves-unknown-keys",
    description: "unknown node keys are kept verbatim (forward compatibility)",
    ops: [
      {
        op: "create",
        nodes: [{ ...r1, futureProp: { a: 1, b: [true, null] } }],
        parent: P1,
        index: 6,
      },
    ],
    after: (d) => {
      add(d, { ...r1, futureProp: { a: 1, b: [true, null] } } as unknown as Node);
      insert(d, P1, N(1));
    },
  },
  ...(
    [
      ["ellipse", createEllipse({ id: N(1), parent: P1, arc: { start: 0, end: 270, inner: 0.5 } })],
      ["polygon", createPolygon({ id: N(1), parent: P1, sides: 5 })],
      ["star", createStar({ id: N(1), parent: P1, points: 7, innerRatio: 0.5 })],
      ["line", createLine({ id: N(1), parent: P1, width: 300, endCap: "arrow" })],
      [
        "path",
        createPath({
          id: N(1),
          parent: P1,
          paths: [{ d: "M0 0L100 50L0 100Z", fillRule: "evenodd" }],
        }),
      ],
      [
        "text",
        text(N(1), P1, "Line one\nLine two", {
          runs: [{ text: "Line one\n" }, { text: "Line two", style: { fontWeight: 400 } }],
        } as Partial<Node>),
      ],
      [
        "image",
        createImage({
          id: N(1),
          parent: P1,
          assetId: ASSET,
          fit: "crop",
          crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        }),
      ],
      [
        "svg",
        createSvg({
          id: N(1),
          parent: P1,
          markup: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#000000"/></svg>',
          recolor: { "#000000": "#ffb02e" },
        }),
      ],
      ["video", createVideo({ id: N(1), parent: P1, assetId: ASSET, loop: true, muted: true })],
      ["audio", createAudio({ id: N(1), parent: P1, assetId: ASSET, fadeInMs: 500 })],
      [
        "chart",
        createChart({
          id: N(1),
          parent: P1,
          data: { labels: ["Q1", "Q2"], series: [{ name: "Revenue", values: [10, 12.5] }] },
        }),
      ],
      ["table", createTable({ id: N(1), parent: P1, rows: 2, cols: 2 })],
      ["qr", createQr({ id: N(1), parent: P1, data: "https://desyn.app/x" })],
    ] as [string, Node][]
  ).map(
    ([type, node]): Case => ({
      name: `create-${type}`,
      description: `create a ${type} node`,
      ops: [{ op: "create", nodes: [node], parent: P1, index: P1_LEN }],
      after: (d) => {
        add(d, node);
        insert(d, P1, node.id);
      },
    }),
  ),
  {
    name: "create-boolean",
    description: "a boolean node with two operands",
    ops: [
      {
        op: "create",
        nodes: [
          createBoolean({
            id: N(1),
            parent: P1,
            op: "subtract",
            children: [N(2), N(3)],
            width: 100,
            height: 50,
          }),
          rect(N(2), N(1), { x: 0, y: 0 }),
          createEllipse({ id: N(3), parent: N(1), x: 25, y: 0, width: 50, height: 50 }),
        ],
        parent: P1,
        index: P1_LEN,
      },
    ],
    after: (d) => {
      add(
        d,
        createBoolean({
          id: N(1),
          parent: P1,
          op: "subtract",
          children: [N(2), N(3)],
          width: 100,
          height: 50,
        }),
        rect(N(2), N(1), { x: 0, y: 0 }),
        createEllipse({ id: N(3), parent: N(1), x: 25, y: 0, width: 50, height: 50 }),
      );
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-group",
    description: "a group created with children whose bounds it already fits",
    ops: [
      {
        op: "create",
        nodes: [
          createGroup({
            id: N(1),
            parent: P1,
            x: 10,
            y: 20,
            width: 100,
            height: 100,
            children: [N(2), N(3)],
          }),
          rect(N(2), N(1), { x: 0, y: 0, width: 100, height: 50 }),
          rect(N(3), N(1), { x: 0, y: 50, width: 100, height: 50 }),
        ],
        parent: P1,
        index: P1_LEN,
      },
    ],
    after: (d) => {
      add(
        d,
        createGroup({
          id: N(1),
          parent: P1,
          x: 10,
          y: 20,
          width: 100,
          height: 100,
          children: [N(2), N(3)],
        }),
        rect(N(2), N(1), { x: 0, y: 0, width: 100, height: 50 }),
        rect(N(3), N(1), { x: 0, y: 50, width: 100, height: 50 }),
      );
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-then-update",
    description: "later ops see nodes created earlier in the same transaction",
    ops: [
      { op: "create", nodes: [r1], parent: P1, index: 6 },
      { op: "update", id: N(1), set: { name: "Renamed" } },
    ],
    after: (d) => {
      add(d, { ...r1, name: "Renamed" } as Node);
      insert(d, P1, N(1));
    },
  },
  {
    name: "create-then-move-child-out",
    description: "a created descendant can be moved out of its new parent in the same transaction",
    ops: [
      { op: "create", nodes: [frame(N(1), P1, [N(2)]), rect(N(2), N(1))], parent: P1, index: 6 },
      { op: "move", id: N(2), parent: P1, index: 0 },
    ],
    after: (d) => {
      add(d, frame(N(1), P1, []), rect(N(2), P1));
      insert(d, P1, N(1));
      insert(d, P1, N(2), 0);
    },
  },

  // ------------------------------------------------------------------------------------------------- update
  {
    name: "update-name",
    description: "shallow set of one key",
    ops: [{ op: "update", id: ELL, set: { name: "Big sun" } }],
    after: (d) => {
      d.nodes[ELL].name = "Big sun";
    },
  },
  {
    name: "update-geometry",
    description: "several keys at once",
    ops: [{ op: "update", id: TEXT, set: { x: 100.5, y: 140, rotation: -12.25 } }],
    after: (d) => {
      Object.assign(d.nodes[TEXT], { x: 100.5, y: 140, rotation: -12.25 });
    },
  },
  {
    name: "update-fills-replaced-whole",
    description: "nested values are replaced, not merged",
    ops: [
      {
        op: "update",
        id: ELL,
        set: {
          fills: [
            {
              type: "linear",
              angle: 135,
              stops: [
                { pos: 0, color: "#ffd66b" },
                { pos: 1, color: "#ff6a1f" },
              ],
            },
          ],
        },
      },
    ],
    after: (d) => {
      d.nodes[ELL].fills = [
        {
          type: "linear",
          angle: 135,
          stops: [
            { pos: 0, color: "#ffd66b" },
            { pos: 1, color: "#ff6a1f" },
          ],
        },
      ];
    },
  },
  {
    name: "update-unset-optional",
    description: "unset removes an optional key",
    ops: [{ op: "update", id: TEXT, unset: ["role"] }],
    after: (d) => {
      delete d.nodes[TEXT].role;
    },
  },
  {
    name: "update-unset-required",
    description: "removing a required key makes the node invalid",
    ops: [{ op: "update", id: TEXT, unset: ["opacity"] }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-set-id",
    description: "id is immutable",
    ops: [{ op: "update", id: ELL, set: { id: N(1) } }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-set-type",
    description: "type is immutable",
    ops: [{ op: "update", id: ELL, set: { type: "rect" } }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-set-parent",
    description: "parent changes only through move",
    ops: [{ op: "update", id: ELL, set: { parent: P2 } }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-set-children",
    description: "children change only through create / delete / move",
    ops: [{ op: "update", id: FRAME, set: { children: [FTEXT, FRECT] } }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-unset-children",
    description: "immutable keys cannot be unset either",
    ops: [{ op: "update", id: FRAME, unset: ["children"] }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-immutable-with-valid-keys",
    description: "one immutable key drops the whole op",
    ops: [{ op: "update", id: ELL, set: { name: "x", id: N(1) } }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "update-missing-node",
    description: "unknown id",
    ops: [{ op: "update", id: N(9), set: { name: "x" } }],
    dropped: [{ index: 0, reason: "missing-node" }],
  },
  {
    name: "update-opacity-out-of-range",
    description: "opacity > 1 is invalid",
    ops: [{ op: "update", id: ELL, set: { opacity: 1.01 } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-negative-height",
    description: "height < 0 is invalid",
    ops: [{ op: "update", id: ELL, set: { height: -0.5 } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-wrong-type-value",
    description: "a string where a number is required",
    ops: [{ op: "update", id: ELL, set: { x: "10" } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-wrong-enum",
    description: "blend must be a known blend mode",
    ops: [{ op: "update", id: ELL, set: { blend: "plus-lighter" } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-uppercase-color",
    description: "colors must be lowercase hex",
    ops: [{ op: "update", id: ELL, set: { fills: [{ type: "solid", color: "#FFB02E" }] } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-null-on-optional-key",
    description: "null is not a valid value for a typed optional key (use unset)",
    ops: [{ op: "update", id: TEXT, set: { role: null } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-add-unknown-key",
    description: "unknown keys may be added",
    ops: [{ op: "update", id: ELL, set: { futureProp: { nested: [1, 2, 3] } } }],
    after: (d) => {
      d.nodes[ELL].futureProp = { nested: [1, 2, 3] };
    },
  },
  {
    name: "update-unset-unknown-key",
    description: "unknown keys may be removed",
    before: design((d) => {
      d.nodes[ELL].futureProp = 7;
    }),
    ops: [{ op: "update", id: ELL, unset: ["futureProp"] }],
    after: (d) => {
      delete d.nodes[ELL].futureProp;
    },
  },
  {
    name: "update-preserves-unknown-keys",
    description: "keys not mentioned in the op are untouched, unknown ones included",
    before: design((d) => {
      d.nodes[ELL].futureProp = { keep: true };
    }),
    ops: [{ op: "update", id: ELL, set: { name: "Renamed" } }],
    after: (d) => {
      d.nodes[ELL].name = "Renamed";
    },
  },
  {
    name: "update-set-and-unset-same-key",
    description: "a key in both set and unset is malformed",
    ops: [{ op: "update", id: ELL, set: { name: "x" }, unset: ["name"] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "update-set-not-object",
    description: "set must be an object",
    ops: [{ op: "update", id: ELL, set: [] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "update-unset-not-strings",
    description: "unset must be an array of strings",
    ops: [{ op: "update", id: ELL, unset: [1] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "update-root-name",
    description: "the root node may be updated like any node",
    ops: [{ op: "update", id: "root", set: { name: "Document" } }],
    after: (d) => {
      d.nodes.root.name = "Document";
    },
  },
  {
    name: "update-page-background",
    description: "page background is a Fill[]",
    ops: [
      {
        op: "update",
        id: P1,
        set: { background: [{ type: "solid", color: { $var: "brand.primary" } }] },
      },
    ],
    after: (d) => {
      d.nodes[P1].background = [{ type: "solid", color: { $var: "brand.primary" } }];
    },
  },
  {
    name: "update-empty",
    description: "an update without set or unset applies and changes nothing",
    ops: [{ op: "update", id: ELL }],
  },
  {
    name: "update-empty-set-normalized",
    description: "empty set / unset are omitted from applied",
    ops: [{ op: "update", id: ELL, set: {}, unset: [] }],
    applied: [{ op: "update", id: ELL }],
  },
  {
    name: "update-unset-deduplicated",
    description: "duplicate unset entries are removed in applied",
    ops: [{ op: "update", id: TEXT, unset: ["role", "role", "alt"] }],
    applied: [{ op: "update", id: TEXT, unset: ["role", "alt"] }],
    after: (d) => {
      delete d.nodes[TEXT].role;
    },
  },
  {
    name: "update-unset-absent-key",
    description: "unsetting a key that is not present is a no-op for that key",
    ops: [{ op: "update", id: ELL, unset: ["alt"] }],
  },
  {
    name: "update-meta-replaced-whole",
    description: "meta is a top-level key: set replaces it entirely",
    before: design((d) => {
      d.nodes[TEXT].meta = { slot: "headline", aiNote: "keep short" };
    }),
    ops: [{ op: "update", id: TEXT, set: { meta: { slot: "title" } } }],
    after: (d) => {
      d.nodes[TEXT].meta = { slot: "title" };
    },
  },
  {
    name: "update-set-and-unset",
    description: "set and unset in one op",
    ops: [
      {
        op: "update",
        id: IMG,
        set: { fit: "crop", crop: { x: 0, y: 0.25, w: 1, h: 0.5 } },
        unset: ["alt"],
      },
    ],
    after: (d) => {
      Object.assign(d.nodes[IMG], { fit: "crop", crop: { x: 0, y: 0.25, w: 1, h: 0.5 } });
      delete d.nodes[IMG].alt;
    },
  },
  {
    name: "update-twice",
    description: "two updates of one node apply in order",
    ops: [
      { op: "update", id: ELL, set: { x: 1, name: "A" } },
      { op: "update", id: ELL, set: { x: 2 } },
    ],
    after: (d) => {
      Object.assign(d.nodes[ELL], { x: 2, name: "A" });
    },
  },
  {
    name: "update-text-runs",
    description: "rich text runs replaced whole",
    ops: [
      {
        op: "update",
        id: TEXT,
        set: {
          runs: [
            { text: "design at the " },
            { text: "speed of light", style: { fontStyle: "italic" } },
          ],
        },
      },
    ],
    after: (d) => {
      d.nodes[TEXT].runs = [
        { text: "design at the " },
        { text: "speed of light", style: { fontStyle: "italic" } },
      ];
    },
  },
  {
    name: "update-invalid-then-valid",
    description: "an invalid update is dropped; the next one still applies",
    ops: [
      { op: "update", id: ELL, set: { opacity: 2 } },
      { op: "update", id: ELL, set: { opacity: 0.5 } },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
    after: (d) => {
      d.nodes[ELL].opacity = 0.5;
    },
  },

  // -------------------------------------------------------------------------------------------------- patch
  {
    name: "patch-fill-color",
    description: "deep set through an array index",
    ops: [{ op: "patch", id: ELL, path: ["fills", 0, "color"], value: "#ff6a1f" }],
    after: (d) => {
      d.nodes[ELL].fills[0].color = "#ff6a1f";
    },
  },
  {
    name: "patch-array-append",
    description: "index == length appends",
    ops: [
      { op: "patch", id: ELL, path: ["fills", 1], value: { type: "solid", color: "#00000033" } },
    ],
    after: (d) => {
      d.nodes[ELL].fills.push({ type: "solid", color: "#00000033" });
    },
  },
  {
    name: "patch-array-out-of-range",
    description: "index > length is invalid",
    ops: [{ op: "patch", id: ELL, path: ["fills", 5], value: { type: "solid", color: "#000000" } }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-negative-index",
    description: "negative indices are invalid",
    ops: [
      { op: "patch", id: ELL, path: ["fills", -1], value: { type: "solid", color: "#000000" } },
    ],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-string-key-on-array",
    description: "arrays are indexed by integers only",
    ops: [{ op: "patch", id: ELL, path: ["fills", "0", "color"], value: "#000000" }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-number-key-on-object",
    description: "objects are indexed by strings only",
    ops: [{ op: "patch", id: TEXT, path: ["style", 0], value: 1 }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-missing-intermediate",
    description: "intermediate values must exist (no auto-creation): frame has no layout",
    ops: [{ op: "patch", id: FRAME, path: ["layout", "gap"], value: 8 }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-through-primitive",
    description: "cannot descend into a number",
    ops: [{ op: "patch", id: ELL, path: ["opacity", "value"], value: 1 }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-top-level-existing",
    description: "a one-segment path replaces a top-level key",
    ops: [{ op: "patch", id: ELL, path: ["name"], value: "Patched" }],
    after: (d) => {
      d.nodes[ELL].name = "Patched";
    },
  },
  {
    name: "patch-top-level-new-key",
    description: "a one-segment path may add a new (unknown) key",
    ops: [{ op: "patch", id: ELL, path: ["futureProp"], value: 1 }],
    after: (d) => {
      d.nodes[ELL].futureProp = 1;
    },
  },
  {
    name: "patch-top-level-new-optional-key",
    description: "adding a typed optional key through patch",
    ops: [{ op: "patch", id: ELL, path: ["alt"], value: "A warm sun" }],
    after: (d) => {
      d.nodes[ELL].alt = "A warm sun";
    },
  },
  {
    name: "patch-empty-path",
    description: "the empty path is invalid for patch (use update)",
    ops: [{ op: "patch", id: ELL, path: [], value: {} }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "patch-id",
    description: "immutable keys cannot be patched",
    ops: [{ op: "patch", id: ELL, path: ["id"], value: N(1) }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "patch-children-element",
    description: "children cannot be patched, even one element",
    ops: [{ op: "patch", id: FRAME, path: ["children", 0], value: FTEXT }],
    dropped: [{ index: 0, reason: "immutable-field" }],
  },
  {
    name: "patch-invalid-result",
    description: "the patched node must stay valid",
    ops: [{ op: "patch", id: ELL, path: ["opacity"], value: 5 }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "patch-null-on-known-key",
    description: "null is not a valid role",
    ops: [{ op: "patch", id: TEXT, path: ["role"], value: null }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "patch-meta-new-key",
    description: "new keys inside an existing object are allowed",
    before: design((d) => {
      d.nodes[TEXT].meta = { slot: "headline" };
    }),
    ops: [{ op: "patch", id: TEXT, path: ["meta", "aiNote"], value: "max 6 words" }],
    after: (d) => {
      d.nodes[TEXT].meta.aiNote = "max 6 words";
    },
  },
  {
    name: "patch-text-font-size",
    description: "fine edit inside the text style",
    ops: [{ op: "patch", id: TEXT, path: ["style", "fontSize"], value: 56 }],
    after: (d) => {
      d.nodes[TEXT].style.fontSize = 56;
    },
  },
  {
    name: "patch-run-text",
    description: "edit one run's text",
    ops: [
      { op: "patch", id: TEXT, path: ["runs", 0, "text"], value: "design at the speed of sun" },
    ],
    after: (d) => {
      d.nodes[TEXT].runs[0].text = "design at the speed of sun";
    },
  },
  {
    name: "patch-corner-radius-element",
    description: "patch one corner of a tuple radius",
    before: design((d) => {
      d.nodes[P2RECT].cornerRadius = [4, 4, 4, 4];
    }),
    ops: [{ op: "patch", id: P2RECT, path: ["cornerRadius", 2], value: 24 }],
    after: (d) => {
      d.nodes[P2RECT].cornerRadius[2] = 24;
    },
  },
  {
    name: "patch-effects-append-empty",
    description: "appending to an empty array uses index 0",
    ops: [
      {
        op: "patch",
        id: ELL,
        path: ["effects", 0],
        value: { type: "glow", radius: 40, strength: 0.6, color: "#ffb02e" },
      },
    ],
    after: (d) => {
      d.nodes[ELL].effects.push({ type: "glow", radius: 40, strength: 0.6, color: "#ffb02e" });
    },
  },
  {
    name: "patch-replace-array-element",
    description: "a whole element can be replaced",
    ops: [
      {
        op: "patch",
        id: ELL,
        path: ["fills", 0],
        value: {
          type: "radial",
          cx: 0.5,
          cy: 0.5,
          rx: 0.5,
          ry: 0.5,
          stops: [
            { pos: 0, color: "#ffd66b" },
            { pos: 1, color: "#ff6a1f" },
          ],
        },
      },
    ],
    after: (d) => {
      d.nodes[ELL].fills[0] = {
        type: "radial",
        cx: 0.5,
        cy: 0.5,
        rx: 0.5,
        ry: 0.5,
        stops: [
          { pos: 0, color: "#ffd66b" },
          { pos: 1, color: "#ff6a1f" },
        ],
      };
    },
  },
  {
    name: "patch-inside-unknown-key",
    description: "paths may go through unknown keys",
    before: design((d) => {
      d.nodes[ELL].futureProp = { a: { b: 1 } };
    }),
    ops: [{ op: "patch", id: ELL, path: ["futureProp", "a", "c"], value: [2] }],
    after: (d) => {
      d.nodes[ELL].futureProp.a.c = [2];
    },
  },
  {
    name: "patch-missing-node",
    description: "unknown id",
    ops: [{ op: "patch", id: N(9), path: ["name"], value: "x" }],
    dropped: [{ index: 0, reason: "missing-node" }],
  },
  {
    name: "patch-fractional-index",
    description: "path segments are strings or integers",
    ops: [{ op: "patch", id: ELL, path: ["fills", 0.5], value: {} }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "patch-missing-value",
    description: "value is required (null is a value, absence is not)",
    ops: [{ op: "patch", id: ELL, path: ["name"] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "patch-then-update",
    description: "patch and update compose in order",
    ops: [
      { op: "patch", id: ELL, path: ["fills", 0, "opacity"], value: 0.5 },
      { op: "update", id: ELL, set: { visible: false } },
    ],
    after: (d) => {
      d.nodes[ELL].fills[0].opacity = 0.5;
      d.nodes[ELL].visible = false;
    },
  },

  // ------------------------------------------------------------------------------------------------- delete
  {
    name: "delete-leaf",
    description: "delete a leaf node",
    ops: [{ op: "delete", id: ELL }],
    after: (d) => removeSubtree(d, ELL),
  },
  {
    name: "delete-frame-subtree",
    description: "deleting a container removes its whole subtree",
    ops: [{ op: "delete", id: FRAME }],
    after: (d) => removeSubtree(d, FRAME),
  },
  {
    name: "delete-page",
    description: "deleting a page removes its content",
    ops: [{ op: "delete", id: P2 }],
    after: (d) => removeSubtree(d, P2),
  },
  {
    name: "delete-group",
    description: "deleting a group removes its children",
    ops: [{ op: "delete", id: GROUP }],
    after: (d) => removeSubtree(d, GROUP),
  },
  {
    name: "delete-child-of-frame",
    description: "siblings keep their order",
    ops: [{ op: "delete", id: FRECT }],
    after: (d) => removeSubtree(d, FRECT),
  },
  {
    name: "delete-missing",
    description: "deleting a missing node changes nothing and is reported as dropped",
    ops: [{ op: "delete", id: N(9) }],
    dropped: [{ index: 0, reason: "missing-node" }],
  },
  {
    name: "delete-root",
    description: "the root cannot be deleted",
    ops: [{ op: "delete", id: "root" }],
    dropped: [{ index: 0, reason: "root-protected" }],
  },
  {
    name: "delete-twice",
    description: "the second delete finds nothing",
    ops: [
      { op: "delete", id: ELL },
      { op: "delete", id: ELL },
    ],
    dropped: [{ index: 1, reason: "missing-node" }],
    after: (d) => removeSubtree(d, ELL),
  },
  {
    name: "delete-descendant-after-ancestor",
    description: "a descendant is gone once its ancestor is deleted",
    ops: [
      { op: "delete", id: FRAME },
      { op: "delete", id: FRECT },
    ],
    dropped: [{ index: 1, reason: "missing-node" }],
    after: (d) => removeSubtree(d, FRAME),
  },
  {
    name: "delete-then-recreate-same-id",
    description: "an id freed by delete may be created again later in the transaction",
    ops: [
      { op: "delete", id: ELL },
      { op: "create", nodes: [rect(ELL, P2)], parent: P2, index: 0 },
    ],
    after: (d) => {
      removeSubtree(d, ELL);
      add(d, rect(ELL, P2));
      insert(d, P2, ELL, 0);
    },
  },
  {
    name: "delete-then-update",
    description: "updates of deleted nodes are dropped",
    ops: [
      { op: "delete", id: ELL },
      { op: "update", id: ELL, set: { name: "x" } },
    ],
    dropped: [{ index: 1, reason: "missing-node" }],
    after: (d) => removeSubtree(d, ELL),
  },
  {
    name: "delete-missing-id-field",
    description: "id is required",
    ops: [{ op: "delete" }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },

  // --------------------------------------------------------------------------------------------------- move
  {
    name: "move-to-index-0",
    description: "send to back",
    ops: [{ op: "move", id: GROUP, parent: P1, index: 0 }],
    after: (d) => moveTo(d, GROUP, P1, 0),
  },
  {
    name: "move-index-omitted-is-top",
    description: "no index = top of the target parent; applied gets the explicit final index",
    ops: [{ op: "move", id: BG, parent: P1 }],
    applied: [{ op: "move", id: BG, parent: P1, index: 5 }],
    after: (d) => moveTo(d, BG, P1),
  },
  {
    name: "move-forward-index-after-removal",
    description:
      "index counts positions after the node is removed: [bg,frame,ell,text,img,group] -> bg at 2",
    ops: [{ op: "move", id: BG, parent: P1, index: 2 }],
    after: (d) => {
      d.nodes[P1].children = [FRAME, ELL, BG, TEXT, IMG, GROUP];
    },
  },
  {
    name: "move-backward",
    description: "move group down to index 1",
    ops: [{ op: "move", id: GROUP, parent: P1, index: 1 }],
    after: (d) => {
      d.nodes[P1].children = [BG, GROUP, FRAME, ELL, TEXT, IMG];
    },
  },
  {
    name: "move-same-position",
    description: "moving to the current position applies and changes nothing",
    ops: [{ op: "move", id: ELL, parent: P1, index: 2 }],
  },
  {
    name: "move-top-when-already-top",
    description: "the top node moved to the top stays",
    ops: [{ op: "move", id: GROUP, parent: P1 }],
    applied: [{ op: "move", id: GROUP, parent: P1, index: 5 }],
  },
  {
    name: "move-index-clamp-high",
    description: "index clamps to the list length after removal",
    ops: [{ op: "move", id: BG, parent: P1, index: 99 }],
    applied: [{ op: "move", id: BG, parent: P1, index: 5 }],
    after: (d) => moveTo(d, BG, P1),
  },
  {
    name: "move-index-clamp-negative",
    description: "negative index clamps to 0",
    ops: [{ op: "move", id: IMG, parent: P1, index: -3 }],
    applied: [{ op: "move", id: IMG, parent: P1, index: 0 }],
    after: (d) => moveTo(d, IMG, P1, 0),
  },
  {
    name: "move-into-frame",
    description: "reparent into a frame at index 1 (x / y are not adjusted)",
    ops: [{ op: "move", id: ELL, parent: FRAME, index: 1 }],
    after: (d) => moveTo(d, ELL, FRAME, 1),
  },
  {
    name: "move-out-of-frame",
    description: "reparent from a frame onto the page top",
    ops: [{ op: "move", id: FRECT, parent: P1 }],
    applied: [{ op: "move", id: FRECT, parent: P1, index: 6 }],
    after: (d) => moveTo(d, FRECT, P1),
  },
  {
    name: "move-to-other-page",
    description: "move across pages",
    ops: [{ op: "move", id: TEXT, parent: P2, index: 1 }],
    after: (d) => moveTo(d, TEXT, P2, 1),
  },
  {
    name: "move-into-own-descendant",
    description: "a container cannot move into its own subtree",
    before: design((d) => {
      d.nodes[N(1)] = frame(N(1), FRAME, []);
      d.nodes[FRAME].children.push(N(1));
    }),
    ops: [{ op: "move", id: FRAME, parent: N(1) }],
    dropped: [{ index: 0, reason: "cycle" }],
  },
  {
    name: "move-into-itself",
    description: "a node cannot be its own parent",
    ops: [{ op: "move", id: FRAME, parent: FRAME }],
    dropped: [{ index: 0, reason: "cycle" }],
  },
  {
    name: "move-missing-node",
    description: "unknown id",
    ops: [{ op: "move", id: N(9), parent: P1 }],
    dropped: [{ index: 0, reason: "missing-node" }],
  },
  {
    name: "move-missing-parent",
    description: "unknown parent",
    ops: [{ op: "move", id: ELL, parent: N(9) }],
    dropped: [{ index: 0, reason: "missing-parent" }],
  },
  {
    name: "move-parent-not-container",
    description: "text nodes cannot hold children",
    ops: [{ op: "move", id: ELL, parent: TEXT }],
    dropped: [{ index: 0, reason: "not-container" }],
  },
  {
    name: "move-page-into-frame",
    description: "pages live under the root only",
    ops: [{ op: "move", id: P2, parent: FRAME }],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "move-node-into-root",
    description: "the root holds pages only",
    ops: [{ op: "move", id: ELL, parent: "root" }],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "move-root",
    description: "the root cannot move",
    ops: [{ op: "move", id: "root", parent: P1 }],
    dropped: [{ index: 0, reason: "root-protected" }],
  },
  {
    name: "move-reorder-pages",
    description: "page order is the root's children order",
    ops: [{ op: "move", id: P2, parent: "root", index: 0 }],
    after: (d) => {
      d.nodes.root.children = [P2, P1];
    },
  },
  {
    name: "move-page-to-end",
    description: "page moved to the end",
    ops: [{ op: "move", id: P1, parent: "root" }],
    applied: [{ op: "move", id: P1, parent: "root", index: 1 }],
    after: (d) => {
      d.nodes.root.children = [P2, P1];
    },
  },
  {
    name: "move-fractional-index",
    description: "index must be an integer",
    ops: [{ op: "move", id: ELL, parent: P1, index: 0.5 }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "move-and-back",
    description: "two moves in sequence",
    ops: [
      { op: "move", id: ELL, parent: FRAME, index: 0 },
      { op: "move", id: ELL, parent: P1, index: 2 },
    ],
  },
  {
    name: "move-out-then-delete-old-parent",
    description: "a node moved out of a container survives the container's deletion",
    ops: [
      { op: "move", id: FTEXT, parent: P1, index: 0 },
      { op: "delete", id: FRAME },
    ],
    after: (d) => {
      moveTo(d, FTEXT, P1, 0);
      removeSubtree(d, FRAME);
    },
  },
  {
    name: "move-preserves-unknown-keys",
    description: "move only changes parent and children lists",
    before: design((d) => {
      d.nodes[ELL].futureProp = "kept";
    }),
    ops: [{ op: "move", id: ELL, parent: P2, index: 0 }],
    after: (d) => moveTo(d, ELL, P2, 0),
  },
  {
    name: "move-into-empty-frame",
    description: "move into a container without children",
    before: design((d) => {
      d.nodes[N(1)] = frame(N(1), P2, []);
      d.nodes[P2].children.push(N(1));
    }),
    ops: [{ op: "move", id: P2RECT, parent: N(1), index: 7 }],
    applied: [{ op: "move", id: P2RECT, parent: N(1), index: 0 }],
    after: (d) => moveTo(d, P2RECT, N(1), 0),
  },

  // -------------------------------------------------------------------------------------------------- asset
  {
    name: "asset-add",
    description: "add an asset record",
    ops: [
      {
        op: "asset",
        set: {
          [N(1)]: {
            id: N(1),
            kind: "svg",
            mime: "image/svg+xml",
            source: "ai",
            ai: { provider: "fal", model: "recraft", prompt: "sun icon" },
          },
        },
      },
    ],
    after: (d) => {
      d.assets[N(1)] = {
        id: N(1),
        kind: "svg",
        mime: "image/svg+xml",
        source: "ai",
        ai: { provider: "fal", model: "recraft", prompt: "sun icon" },
      };
    },
  },
  {
    name: "asset-replace-existing",
    description: "set replaces the whole record",
    ops: [
      {
        op: "asset",
        set: {
          [ASSET]: { id: ASSET, kind: "image", mime: "image/webp", width: 1200, height: 800 },
        },
      },
    ],
    after: (d) => {
      d.assets[ASSET] = { id: ASSET, kind: "image", mime: "image/webp", width: 1200, height: 800 };
    },
  },
  {
    name: "asset-remove-existing",
    description: "remove deletes records (nodes may still reference them)",
    ops: [{ op: "asset", remove: [ASSET] }],
    after: (d) => {
      delete d.assets[ASSET];
    },
  },
  {
    name: "asset-remove-missing",
    description: "missing ids in remove are ignored and omitted from applied",
    ops: [{ op: "asset", remove: [N(9)] }],
    applied: [{ op: "asset" }],
  },
  {
    name: "asset-remove-duplicates",
    description: "remove is de-duplicated",
    ops: [{ op: "asset", remove: [ASSET, ASSET] }],
    applied: [{ op: "asset", remove: [ASSET] }],
    after: (d) => {
      delete d.assets[ASSET];
    },
  },
  {
    name: "asset-set-and-remove",
    description: "set new records and remove others in one op",
    ops: [
      {
        op: "asset",
        set: {
          [N(1)]: {
            id: N(1),
            kind: "font",
            mime: "font/woff2",
            family: "Fraunces",
            weight: 600,
            style: "italic",
          },
        },
        remove: [N(9), ASSET],
      },
    ],
    applied: [
      {
        op: "asset",
        set: {
          [N(1)]: {
            id: N(1),
            kind: "font",
            mime: "font/woff2",
            family: "Fraunces",
            weight: 600,
            style: "italic",
          },
        },
        remove: [ASSET],
      },
    ],
    after: (d) => {
      d.assets[N(1)] = {
        id: N(1),
        kind: "font",
        mime: "font/woff2",
        family: "Fraunces",
        weight: 600,
        style: "italic",
      };
      delete d.assets[ASSET];
    },
  },
  {
    name: "asset-key-id-mismatch",
    description: "set keys must equal the record id",
    ops: [{ op: "asset", set: { [N(1)]: { id: N(2), kind: "image", mime: "image/png" } } }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "asset-invalid-record",
    description: "records must match AssetRef (mime is required)",
    ops: [{ op: "asset", set: { [N(1)]: { id: N(1), kind: "image" } } }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "asset-set-and-remove-same-id",
    description: "an id cannot be both set and removed",
    ops: [
      {
        op: "asset",
        set: { [ASSET]: { id: ASSET, kind: "image", mime: "image/png" } },
        remove: [ASSET],
      },
    ],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "asset-preserves-unknown-keys",
    description: "asset records keep unknown keys",
    ops: [
      {
        op: "asset",
        set: {
          [N(1)]: { id: N(1), kind: "lottie", mime: "application/json", futureField: { fps: 60 } },
        },
      },
    ],
    after: (d) => {
      d.assets[N(1)] = {
        id: N(1),
        kind: "lottie",
        mime: "application/json",
        futureField: { fps: 60 },
      };
    },
  },
  {
    name: "asset-empty",
    description: "an asset op with nothing to do applies as a no-op",
    ops: [{ op: "asset", set: {}, remove: [] }],
    applied: [{ op: "asset" }],
  },

  // ------------------------------------------------------------------------------------------------- styles
  {
    name: "styles-add-color",
    description: "add a color style",
    ops: [{ op: "styles", path: ["colors", N(1)], value: { name: "Ember", value: "#ff6a1f" } }],
    after: (d) => {
      d.styles.colors[N(1)] = { name: "Ember", value: "#ff6a1f" };
    },
  },
  {
    name: "styles-change-variable",
    description: "change a design variable",
    ops: [{ op: "styles", path: ["variables", "brand.primary"], value: "#d27400" }],
    after: (d) => {
      d.styles.variables["brand.primary"] = "#d27400";
    },
  },
  {
    name: "styles-new-variable",
    description: "variables may be numbers, strings or booleans",
    ops: [{ op: "styles", path: ["variables", "spacing.unit"], value: 8 }],
    after: (d) => {
      d.styles.variables["spacing.unit"] = 8;
    },
  },
  {
    name: "styles-deep-text-style",
    description: "deep set inside a text style",
    ops: [{ op: "styles", path: ["text", TEXT_STYLE, "style", "fontSize"], value: 72 }],
    after: (d) => {
      d.styles.text[TEXT_STYLE].style.fontSize = 72;
    },
  },
  {
    name: "styles-replace-colors-map",
    description: "replace a whole style map (the way to remove entries)",
    ops: [{ op: "styles", path: ["colors"], value: {} }],
    after: (d) => {
      d.styles.colors = {};
    },
  },
  {
    name: "styles-empty-path",
    description: "the empty path replaces Design.styles entirely",
    ops: [{ op: "styles", path: [], value: { colors: {}, text: {}, effects: {}, variables: {} } }],
    after: (d) => {
      d.styles = { colors: {}, text: {}, effects: {}, variables: {} };
    },
  },
  {
    name: "styles-effect-array-element",
    description: "deep set through an effects array",
    ops: [{ op: "styles", path: ["effects", FX_STYLE, "effects", 0, "blur"], value: 32 }],
    after: (d) => {
      d.styles.effects[FX_STYLE].effects[0].blur = 32;
    },
  },
  {
    name: "styles-append-effect",
    description: "append to an effects array",
    ops: [
      {
        op: "styles",
        path: ["effects", FX_STYLE, "effects", 1],
        value: { type: "layerBlur", radius: 4 },
      },
    ],
    after: (d) => {
      d.styles.effects[FX_STYLE].effects.push({ type: "layerBlur", radius: 4 });
    },
  },
  {
    name: "styles-invalid-path",
    description: "intermediate keys must exist",
    ops: [{ op: "styles", path: ["text", N(9), "style", "fontSize"], value: 10 }],
    dropped: [{ index: 0, reason: "invalid-path" }],
  },
  {
    name: "styles-invalid-value",
    description: "the result must be valid DesignStyles",
    ops: [{ op: "styles", path: ["colors", COLOR_STYLE, "value"], value: "red" }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "styles-invalid-style-id",
    description: "style map keys are Ids",
    ops: [
      { op: "styles", path: ["colors", "Primary"], value: { name: "Primary", value: "#000000" } },
    ],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "styles-path-not-array",
    description: "path must be an array",
    ops: [{ op: "styles", path: "colors", value: {} }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },

  // ---------------------------------------------------------------------------------------------------- doc
  {
    name: "doc-rename",
    description: "rename the design",
    ops: [{ op: "doc", set: { name: "Launch post" } }],
    after: (d) => {
      d.name = "Launch post";
    },
  },
  {
    name: "doc-change-kind",
    description: "change the design kind",
    ops: [{ op: "doc", set: { kind: "story" } }],
    after: (d) => {
      d.kind = "story";
    },
  },
  {
    name: "doc-invalid-kind",
    description: "kind must be a DesignKind",
    ops: [{ op: "doc", set: { kind: "billboard" } }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "doc-name-not-string",
    description: "name must be a string",
    ops: [{ op: "doc", set: { name: 42 } }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "doc-set-brand-kit",
    description: "attach a brand kit",
    ops: [{ op: "doc", set: { brandKitId: "k57a1b2c3d4e5f6g7h8" } }],
    after: (d) => {
      d.brandKitId = "k57a1b2c3d4e5f6g7h8";
    },
  },
  {
    name: "doc-unset-brand-kit",
    description: "detach the brand kit (additive unset, change log 2026-10-20)",
    before: design((d) => {
      d.brandKitId = "k57a1b2c3d4e5f6g7h8";
    }),
    ops: [{ op: "doc", set: {}, unset: ["brandKitId"] }],
    after: (d) => {
      delete d.brandKitId;
    },
  },
  {
    name: "doc-unset-brand-kit-absent",
    description: "unsetting an absent brandKitId applies and changes nothing",
    ops: [{ op: "doc", set: {}, unset: ["brandKitId"] }],
  },
  {
    name: "doc-set-and-unset-brand-kit",
    description: "brandKitId cannot be set and unset at once",
    ops: [{ op: "doc", set: { brandKitId: "k1" }, unset: ["brandKitId"] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "doc-replace-meta",
    description: "meta is replaced whole",
    ops: [{ op: "doc", set: { meta: { locale: "de-DE", templateId: "tpl_1" } } }],
    after: (d) => {
      d.meta = { locale: "de-DE", templateId: "tpl_1" };
    },
  },
  {
    name: "doc-unknown-key",
    description: "doc.set accepts name, kind, brandKitId, meta only",
    ops: [{ op: "doc", set: { id: N(1) } }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "doc-missing-set",
    description: "set is required",
    ops: [{ op: "doc" }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "doc-set-multiple",
    description: "several fields at once",
    ops: [{ op: "doc", set: { name: "Deck", kind: "presentation", meta: { tags: ["q4"] } } }],
    after: (d) => {
      Object.assign(d, { name: "Deck", kind: "presentation", meta: { tags: ["q4"] } });
    },
  },

  // ------------------------------------------------------------------------------------------------ general
  {
    name: "empty-transaction",
    description: "no ops: nothing changes",
    ops: [],
  },
  {
    name: "unknown-op-kind",
    description: "unknown op kinds are malformed",
    ops: [{ op: "frobnicate", id: ELL }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "op-not-object",
    description: "ops must be objects",
    ops: [42, null],
    dropped: [
      { index: 0, reason: "invalid-op" },
      { index: 1, reason: "invalid-op" },
    ],
  },
  {
    name: "mixed-with-drops",
    description: "dropped indices refer to positions in tx.ops; the rest still apply",
    ops: [
      { op: "update", id: ELL, set: { name: "A" } },
      { op: "delete", id: N(9) },
      { op: "move", id: ELL, parent: TEXT },
      { op: "update", id: TEXT, set: { name: "B" } },
      { op: "patch", id: TEXT, path: [], value: 1 },
    ],
    dropped: [
      { index: 1, reason: "missing-node" },
      { index: 2, reason: "not-container" },
      { index: 4, reason: "invalid-path" },
    ],
    after: (d) => {
      d.nodes[ELL].name = "A";
      d.nodes[TEXT].name = "B";
    },
  },
  {
    name: "order-dependence",
    description: "an op referencing a node created later in the list is dropped",
    ops: [
      { op: "update", id: N(1), set: { name: "x" } },
      { op: "create", nodes: [r1], parent: P1, index: 0 },
    ],
    dropped: [{ index: 0, reason: "missing-node" }],
    after: (d) => {
      add(d, r1);
      insert(d, P1, N(1), 0);
    },
  },
  {
    name: "unknown-design-keys-preserved",
    description: "unknown top-level design keys survive any transaction",
    before: design((d) => {
      d.futureTop = { flags: ["x"] };
    }),
    ops: [{ op: "update", id: ELL, set: { name: "x" } }],
    after: (d) => {
      d.nodes[ELL].name = "x";
    },
  },
  {
    name: "unicode-text-and-keys",
    description: "non-ASCII strings and keys are preserved",
    ops: [
      { op: "update", id: TEXT, set: { runs: [{ text: "日本語 — émoji 🌅 עברית" }] } },
      { op: "styles", path: ["variables", "ünïcødé.key"], value: "✓" },
    ],
    after: (d) => {
      d.nodes[TEXT].runs = [{ text: "日本語 — émoji 🌅 עברית" }];
      d.styles.variables["ünïcødé.key"] = "✓";
    },
  },
  {
    name: "ai-restyle-batch",
    description: "a realistic multi-op AI edit: palette, copy, new badge, reorder",
    ops: [
      { op: "update", id: BG, set: { fills: [{ type: "solid", color: "#0a0a0a" }] } },
      { op: "patch", id: TEXT, path: ["style", "fills", 0, "color"], value: "#ededed" },
      { op: "patch", id: TEXT, path: ["runs", 0, "text"], value: "the sun is up" },
      {
        op: "create",
        nodes: [rect(N(1), P1, { name: "Glow", role: "decoration", opacity: 0.3 })],
        parent: P1,
        index: 1,
      },
      { op: "move", id: ELL, parent: P1, index: 1 },
      { op: "styles", path: ["variables", "brand.dark"], value: true },
      { op: "doc", set: { name: "Fixture design (dark)" } },
    ],
    after: (d) => {
      d.nodes[BG].fills = [{ type: "solid", color: "#0a0a0a" }];
      d.nodes[TEXT].style.fills[0].color = "#ededed";
      d.nodes[TEXT].runs[0].text = "the sun is up";
      add(d, rect(N(1), P1, { name: "Glow", role: "decoration", opacity: 0.3 }));
      insert(d, P1, N(1), 1);
      moveTo(d, ELL, P1, 1);
      d.name = "Fixture design (dark)";
    },
  },
  {
    name: "group-rename-only",
    description: "renaming a group does not touch its children",
    ops: [{ op: "update", id: GROUP, set: { name: "Pill" } }],
    after: (d) => {
      d.nodes[GROUP].name = "Pill";
    },
  },
  {
    name: "delete-group-child-and-sibling",
    description: "delete inside a group and on the page in one transaction",
    ops: [
      { op: "delete", id: GELL },
      { op: "delete", id: P2TEXT },
    ],
    after: (d) => {
      removeSubtree(d, GELL);
      removeSubtree(d, P2TEXT);
    },
  },
  {
    name: "image-node-crop-patch",
    description: "patch a new crop then a crop field",
    ops: [
      { op: "update", id: IMG, set: { fit: "crop", crop: { x: 0, y: 0, w: 1, h: 1 } } },
      { op: "patch", id: IMG, path: ["crop", "zoom"], value: 1.5 },
    ],
    after: (d) => {
      Object.assign(d.nodes[IMG], { fit: "crop", crop: { x: 0, y: 0, w: 1, h: 1, zoom: 1.5 } });
    },
  },
  {
    name: "rich-text-style-run",
    description: "partial run styles validate as Partial<TextStyle>",
    ops: [
      {
        op: "patch",
        id: FTEXT,
        path: ["runs", 0, "style"],
        value: { fontWeight: 600, decoration: "underline" },
      },
    ],
    after: (d) => {
      d.nodes[FTEXT].runs[0].style = { fontWeight: 600, decoration: "underline" };
    },
  },
  {
    name: "run-style-invalid",
    description: "an invalid partial run style is rejected",
    ops: [{ op: "patch", id: FTEXT, path: ["runs", 0, "style"], value: { fontStyle: "oblique" } }],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "text-style-ref",
    description: "text nodes may reference a text style",
    ops: [{ op: "update", id: TEXT, set: { styleRef: TEXT_STYLE } }],
    after: (d) => {
      d.nodes[TEXT].styleRef = TEXT_STYLE;
    },
  },
  {
    name: "color-style-ref-fill",
    description: "fills may reference a color style",
    ops: [
      {
        op: "update",
        id: GRECT,
        set: { fills: [{ type: "solid", color: { $style: COLOR_STYLE } }] },
      },
    ],
    after: (d) => {
      d.nodes[GRECT].fills = [{ type: "solid", color: { $style: COLOR_STYLE } }];
    },
  },
  {
    name: "page-update-transition",
    description: "presentation page fields",
    ops: [
      {
        op: "update",
        id: P2,
        set: {
          transition: { kind: "fade", durationMs: 400 },
          durationMs: 5000,
          notes: "Pause here.",
        },
      },
    ],
    after: (d) => {
      Object.assign(d.nodes[P2], {
        transition: { kind: "fade", durationMs: 400 },
        durationMs: 5000,
        notes: "Pause here.",
      });
    },
  },
  {
    name: "animation-add",
    description: "entrance animation on a node",
    ops: [
      {
        op: "update",
        id: TEXT,
        set: {
          anim: [
            {
              id: N(5),
              preset: "rise",
              phase: "in",
              startMs: 0,
              durationMs: 600,
              easing: "ease-out",
            },
          ],
        },
      },
    ],
    after: (d) => {
      d.nodes[TEXT].anim = [
        { id: N(5), preset: "rise", phase: "in", startMs: 0, durationMs: 600, easing: "ease-out" },
      ];
    },
  },
  {
    name: "move-group-child-reorder",
    description: "reordering inside a group keeps the group's bounds (same children)",
    ops: [{ op: "move", id: GELL, parent: GROUP, index: 0 }],
    after: (d) => {
      d.nodes[GROUP].children = [GELL, GRECT];
    },
  },
  // ------------------------------------------------------------------------------------ edge cases (review)
  {
    name: "doc-unset-empty",
    description: "an empty doc.unset is allowed and omitted from applied",
    ops: [{ op: "doc", set: { name: "Renamed" }, unset: [] }],
    applied: [{ op: "doc", set: { name: "Renamed" } }],
    after: (d) => {
      d.name = "Renamed";
    },
  },
  {
    name: "doc-unset-duplicates",
    description: "repeated brandKitId entries in doc.unset collapse to one",
    before: design((d) => {
      d.brandKitId = "k57a1b2c3d4e5f6g7h8";
    }),
    ops: [{ op: "doc", set: {}, unset: ["brandKitId", "brandKitId"] }],
    applied: [{ op: "doc", set: {}, unset: ["brandKitId"] }],
    after: (d) => {
      delete d.brandKitId;
    },
  },
  {
    name: "doc-unset-other-key",
    description: "brandKitId is the only design field doc.unset may name",
    ops: [{ op: "doc", set: {}, unset: ["name"] }],
    dropped: [{ index: 0, reason: "invalid-op" }],
  },
  {
    name: "asset-malformed-fields",
    description: "asset.set must be an object and asset.remove an array of strings",
    ops: [
      { op: "asset", set: [{ id: ASSET, kind: "image", mime: "image/png" }] },
      { op: "asset", remove: ASSET },
      { op: "asset", remove: [ASSET, 7] },
    ],
    dropped: [
      { index: 0, reason: "invalid-op" },
      { index: 1, reason: "invalid-op" },
      { index: 2, reason: "invalid-op" },
    ],
  },
  {
    name: "styles-replace-missing-required-map",
    description: "replacing Design.styles with an object that lacks a required map is invalid",
    ops: [{ op: "styles", path: [], value: { colors: {}, text: {}, variables: {} } }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "styles-variable-object-value",
    description: "variables hold strings, numbers or booleans only",
    ops: [{ op: "styles", path: ["variables", "brand.shadow"], value: { y: 8 } }],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "styles-unknown-top-level-key",
    description: "unknown keys inside Design.styles are allowed and preserved",
    ops: [{ op: "styles", path: ["gradients"], value: { g1: { stops: 2 } } }],
    after: (d) => {
      d.styles.gradients = { g1: { stops: 2 } };
    },
  },
  {
    name: "update-proto-key-is-data",
    description:
      'a "__proto__" key is an ordinary unknown key (stored as data, never a prototype change)',
    ops: [JSON.parse(`{"op":"update","id":"${ELL}","set":{"__proto__":{"polluted":true}}}`)],
    after: (d) => {
      Object.defineProperty(d.nodes[ELL], "__proto__", {
        value: { polluted: true },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  },
  {
    name: "styles-proto-key-validated",
    description:
      'a "__proto__" entry of a style map is validated like any other entry (here: not a valid variable value)',
    ops: [JSON.parse('{"op":"styles","path":["variables"],"value":{"__proto__":{"a":1}}}')],
    dropped: [{ index: 0, reason: "invalid-value" }],
  },
  {
    name: "styles-proto-variable-is-data",
    description: 'a "__proto__" variable with a valid value is ordinary data',
    ops: [JSON.parse('{"op":"styles","path":["variables","__proto__"],"value":"#123456"}')],
    after: (d) => {
      Object.defineProperty(d.styles.variables, "__proto__", {
        value: "#123456",
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  },
  {
    name: "create-node-type-not-string",
    description:
      "a node whose type is not a known type string is invalid, even if its other fields look like a page",
    ops: [
      {
        op: "create",
        nodes: [{ ...(createPage({ id: N(1), name: "Page 3" }) as object), type: 1 }],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "update-fill-type-not-string",
    description:
      "fill and effect discriminants must be type strings (an integer is not a variant index)",
    ops: [
      { op: "update", id: BG, set: { fills: [{ type: 0, color: "#000000" }] } },
      {
        op: "update",
        id: BG,
        set: { effects: [{ type: 0, x: 0, y: 4, blur: 8, spread: 0, color: "#00000040" }] },
      },
    ],
    dropped: [
      { index: 0, reason: "invalid-node" },
      { index: 1, reason: "invalid-node" },
    ],
  },
  {
    name: "update-enum-not-string",
    description: "string enums (blend mode, autoResize, unit) reject integers",
    ops: [
      { op: "update", id: BG, set: { blend: 0 } },
      { op: "update", id: TEXT, set: { autoResize: 1 } },
      { op: "update", id: P1, set: { unit: 0 } },
    ],
    dropped: [
      { index: 0, reason: "invalid-node" },
      { index: 1, reason: "invalid-node" },
      { index: 2, reason: "invalid-node" },
    ],
  },
  {
    name: "update-unknown-key-null",
    description: "unknown keys may hold null (only typed keys reject null)",
    ops: [{ op: "update", id: ELL, set: { futureProp: null } }],
    after: (d) => {
      d.nodes[ELL].futureProp = null;
    },
  },
  {
    name: "patch-root-name",
    description: "the root node can be patched like any other node",
    ops: [{ op: "patch", id: "root", path: ["name"], value: "Document" }],
    after: (d) => {
      d.nodes.root.name = "Document";
    },
  },
  {
    name: "create-children-listed-twice",
    description: "an id may appear only once across the children lists of a create op",
    ops: [
      {
        op: "create",
        nodes: [frame(N(1), P1, [N(2), N(2)]), rect(N(2), N(1))],
        parent: P1,
      },
    ],
    dropped: [{ index: 0, reason: "invalid-node" }],
  },
  {
    name: "create-child-in-group-within-bounds",
    description: "create inside a group without changing its bounds (layout-insensitive)",
    ops: [
      {
        op: "create",
        nodes: [rect(N(1), GROUP, { x: 90, y: 10, width: 20, height: 20 })],
        parent: GROUP,
        index: 1,
      },
    ],
    applied: [
      {
        op: "create",
        nodes: [rect(N(1), GROUP, { x: 90, y: 10, width: 20, height: 20 })],
        parent: GROUP,
        index: 1,
      },
    ],
    after: (d) => {
      add(d, rect(N(1), GROUP, { x: 90, y: 10, width: 20, height: 20 }));
      insert(d, GROUP, N(1), 1);
    },
  },
  {
    name: "create-many-decimals",
    description:
      "numbers are stored as given; comparisons use canonical JSON (6 decimals, no -0, no exponent)",
    ops: [
      {
        op: "create",
        nodes: [rect(N(1), P1, { x: 0.1234567, y: -0.0000001, rotation: 1e21, width: 1.5e-7 })],
        parent: P1,
        index: 0,
      },
    ],
    applied: [
      {
        op: "create",
        nodes: [rect(N(1), P1, { x: 0.1234567, y: -0.0000001, rotation: 1e21, width: 1.5e-7 })],
        parent: P1,
        index: 0,
      },
    ],
    after: (d) => {
      add(d, rect(N(1), P1, { x: 0.1234567, y: -0.0000001, rotation: 1e21, width: 1.5e-7 }));
      insert(d, P1, N(1), 0);
    },
  },
  {
    name: "asset-add-several-unsorted",
    description:
      "the inverse removes added ids in code point order, whatever the key order of asset.set",
    ops: [
      {
        op: "asset",
        set: {
          [N(3)]: { id: N(3), kind: "image", mime: "image/png" },
          [N(1)]: { id: N(1), kind: "font", mime: "font/woff2", family: "Inter", weight: 400 },
          [N(2)]: { id: N(2), kind: "audio", mime: "audio/mpeg", durationMs: 1200 },
        },
      },
    ],
    after: (d) => {
      d.assets[N(3)] = { id: N(3), kind: "image", mime: "image/png" };
      d.assets[N(1)] = { id: N(1), kind: "font", mime: "font/woff2", family: "Inter", weight: 400 };
      d.assets[N(2)] = { id: N(2), kind: "audio", mime: "audio/mpeg", durationMs: 1200 };
    },
  },
  {
    name: "update-new-keys-unsorted",
    description:
      "the inverse unsets new keys in code point order, whatever the key order of update.set",
    ops: [{ op: "update", id: ELL, set: { zeta: 1, alt: "Sun disc", link: "page:page00000002" } }],
    after: (d) => {
      Object.assign(d.nodes[ELL], { zeta: 1, alt: "Sun disc", link: "page:page00000002" });
    },
  },
  {
    name: "move-page-into-page",
    description: "a page cannot become the child of another page",
    ops: [{ op: "move", id: P2, parent: P1 }],
    dropped: [{ index: 0, reason: "page-nesting" }],
  },
  {
    name: "move-index-equals-length-after-removal",
    description:
      "within the same parent the clamp bound is the length after removal (5 here), so 5 is the top",
    ops: [{ op: "move", id: BG, parent: P1, index: 5 }],
    applied: [{ op: "move", id: BG, parent: P1, index: 5 }],
    after: (d) => {
      moveTo(d, BG, P1, 5);
    },
  },
  {
    name: "move-index-one-past-length-clamps",
    description:
      "index 6 equals the length before removal; it clamps to 5 (the length after removal)",
    ops: [{ op: "move", id: BG, parent: P1, index: 6 }],
    applied: [{ op: "move", id: BG, parent: P1, index: 5 }],
    after: (d) => {
      moveTo(d, BG, P1, 5);
    },
  },
];
