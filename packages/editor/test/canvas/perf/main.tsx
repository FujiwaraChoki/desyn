import {
  type AssetRef,
  createDesign,
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createPath,
  createPolygon,
  createRect,
  createStar,
  createText,
  type Design,
  defaultStroke,
  defaultTextStyle,
  type Id,
  type Node,
  newId,
  type PageNode,
  solid,
} from "@desyn/schema";
import { DesynProvider } from "@desyn/ui";
import { createRoot } from "react-dom/client";
import { canvasControllerOf } from "../../../src/canvas/registry.ts";
import { EditorProvider } from "../../../src/context.tsx";
import { EditorController } from "../../../src/controller.ts";
import { BUILTIN_EXTENSIONS } from "../../../src/extensions.ts";
import { Shell } from "../../../src/shell/shell.tsx";
import { MemoryPendingStore } from "../../../src/sync/pending-store.ts";
import { FakeServer, FakeTransport, fakeBackend } from "../../fake-server.ts";

/**
 * A 1920×1080 page with ~2,000 layers: a confetti background of small shapes, a grid of 48 cards (frames with
 * an image, texts, shapes, a group and a line), an auto-layout row of chips, paths and a photo.
 * Deterministic (seeded), so timings are comparable between runs.
 */

const W = 1920;
const H = 1080;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PALETTE = ["#ffb02e", "#ff6a1f", "#ffd66b", "#c4451c", "#8a5a00", "#e8e1d3", "#7a7468"];

function photo(): Promise<{ url: string; bytes: number }> {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 800);
  grad.addColorStop(0, "#ffd66b");
  grad.addColorStop(0.55, "#ff6a1f");
  grad.addColorStop(1, "#2a0e05");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1200, 800);
  g.fillStyle = "rgba(255,240,200,0.92)";
  g.beginPath();
  g.arc(600, 470, 150, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#1a0a04";
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.moveTo(i * 150, 800);
    g.lineTo(i * 150 + 220, 520 + (i % 3) * 30);
    g.lineTo(i * 150 + 440, 800);
    g.fill();
  }
  return new Promise((resolve) =>
    c.toBlob(
      (b) => resolve({ url: URL.createObjectURL(b as Blob), bytes: (b as Blob).size }),
      "image/png",
    ),
  );
}

async function buildDesign(): Promise<{ design: Design; ids: Record<string, Id> }> {
  const design = createDesign("presentation");
  const pageId = (design.nodes.root as Node & { children: Id[] }).children[0] as Id;
  const page = design.nodes[pageId] as PageNode;
  page.width = W;
  page.height = H;
  page.name = "Canvas harness";
  page.background = [solid("#141110")];
  page.guides = [];
  page.grid = { columns: 12, gutter: 24, margin: 64 };
  const add = (parent: Id, n: Node) => {
    n.parent = parent;
    design.nodes[n.id] = n;
    (design.nodes[parent] as Node & { children: Id[] }).children.push(n.id);
    return n.id;
  };
  const r = rng(7);
  const ids: Record<string, Id> = {};

  // Confetti background: 1,300 small shapes.
  for (let i = 0; i < 1300; i++) {
    const x = r() * W;
    const y = r() * H;
    const s = 4 + r() * 10;
    const color = PALETTE[Math.floor(r() * PALETTE.length)] as string;
    const kind = i % 3;
    const n =
      kind === 0
        ? createRect({
            name: `Dot ${i}`,
            x,
            y,
            width: s,
            height: s,
            rotation: r() * 90,
            fills: [solid(color, 0.35)],
          })
        : kind === 1
          ? createEllipse({
              name: `Dot ${i}`,
              x,
              y,
              width: s,
              height: s,
              fills: [solid(color, 0.35)],
            })
          : createPolygon({
              name: `Dot ${i}`,
              x,
              y,
              width: s,
              height: s,
              sides: 3,
              fills: [solid(color, 0.35)],
            });
    add(pageId, n);
  }

  // Title.
  ids.title = add(
    pageId,
    createText({
      name: "Title",
      x: 64,
      y: 40,
      width: 1100,
      runs: [
        { text: "Design at the speed of " },
        { text: "light", style: { fontStyle: "italic", fills: [solid("#ffb02e")] } },
      ],
      style: defaultTextStyle({
        fontFamily: "Instrument Serif",
        fontSize: 72,
        fills: [solid("#ededed")],
      }),
      autoResize: "width",
      height: 86,
    }),
  );

  // 48 cards.
  const { url, bytes } = await photo();
  const asset: AssetRef = {
    id: newId(),
    kind: "image",
    url,
    mime: "image/png",
    bytes,
    width: 1200,
    height: 800,
    name: "Sunset",
  };
  design.assets[asset.id] = asset;
  const cols = 8;
  for (let i = 0; i < 48; i++) {
    const cx = 64 + (i % cols) * 228;
    const cy = 170 + Math.floor(i / cols) * 148;
    const card = createFrame({
      name: `Card ${i + 1}`,
      x: cx,
      y: cy,
      width: 208,
      height: 132,
      cornerRadius: 14,
      fills: [solid(i % 2 ? "#1f1a17" : "#241d18")],
      strokes: [defaultStroke({ width: 1, fills: [solid("#ffffff", 0.08)], align: "inside" })],
    });
    const id = add(pageId, card);
    if (i === 0) ids.card = id;
    if (i === 9) ids.card2 = id;
    add(
      id,
      createRect({
        name: "Swatch",
        x: 12,
        y: 12,
        width: 56,
        height: 56,
        cornerRadius: 10,
        fills: [solid(PALETTE[i % PALETTE.length] as string)],
      }),
    );
    add(
      id,
      createText({
        name: "Card title",
        x: 80,
        y: 14,
        width: 116,
        runs: [{ text: `Card ${i + 1}` }],
        style: defaultTextStyle({
          fontFamily: "Instrument Sans",
          fontSize: 15,
          fontWeight: 600,
          fills: [solid("#ededed")],
        }),
        height: 18,
      }),
    );
    add(
      id,
      createText({
        name: "Card body",
        x: 80,
        y: 36,
        width: 116,
        runs: [{ text: "Warm light, calm type and one glowing accent." }],
        style: defaultTextStyle({ fontFamily: "Inter", fontSize: 10, fills: [solid("#a39a90")] }),
        height: 36,
      }),
    );
    for (let k = 0; k < 3; k++) {
      add(
        id,
        createEllipse({
          name: `Pip ${k + 1}`,
          x: 12 + k * 14,
          y: 104,
          width: 8,
          height: 8,
          fills: [solid(k === 0 ? "#ffb02e" : "#5a514a")],
        }),
      );
    }
    add(
      id,
      createStar({ name: "Star", x: 176, y: 96, width: 20, height: 20, fills: [solid("#ffd66b")] }),
    );
    add(
      id,
      createLine({
        name: "Rule",
        x: 12,
        y: 84,
        width: 184,
        strokes: [defaultStroke({ width: 1, fills: [solid("#ffffff", 0.12)] })],
      }),
    );
    const g = createGroup({ name: "Badge", x: 120, y: 98, width: 44, height: 18 });
    const gid = add(id, g);
    add(
      gid,
      createRect({
        name: "Badge bg",
        x: 0,
        y: 0,
        width: 44,
        height: 18,
        cornerRadius: 9,
        fills: [solid("#ff6a1f", 0.2)],
      }),
    );
    add(
      gid,
      createRect({
        name: "Badge dot",
        x: 6,
        y: 6,
        width: 6,
        height: 6,
        cornerRadius: 3,
        fills: [solid("#ff6a1f")],
      }),
    );
  }

  // Auto-layout row of chips.
  const row = createFrame({
    name: "Chips",
    x: 1300,
    y: 50,
    width: 560,
    height: 52,
    cornerRadius: 26,
    fills: [solid("#1f1a17")],
    layout: {
      mode: "row",
      gap: 10,
      padding: [10, 12, 10, 12],
      mainAlign: "start",
      crossAlign: "center",
    },
  });
  ids.row = add(pageId, row);
  ["Social", "Story", "Poster", "Slides", "Logo"].forEach((label, k) => {
    const chip = createRect({
      name: label,
      x: 12 + k * 104,
      y: 10,
      width: 94,
      height: 32,
      cornerRadius: 16,
      fills: [solid(PALETTE[k] as string)],
    });
    const cid = add(ids.row as Id, chip);
    if (k === 0) ids.chip = cid;
  });

  // Photo and a path.
  ids.photo = add(
    pageId,
    createImage({
      name: "Sunset photo",
      assetId: asset.id,
      x: 1500,
      y: 660,
      width: 360,
      height: 200,
      fit: "fill",
      cornerRadius: 18,
    }),
  );
  ids.wave = add(
    pageId,
    createPath({
      name: "Wave",
      x: 1500,
      y: 920,
      width: 360,
      height: 80,
      fills: [],
      strokes: [defaultStroke({ width: 4, fills: [solid("#ffb02e")], cap: "round" })],
      paths: [{ d: "M0 40C60 0 120 0 180 40S300 80 360 40", fillRule: "nonzero" }],
    }),
  );
  ids.page = pageId;
  return { design, ids };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const { design, ids } = await buildDesign();
  const server = new FakeServer(design);
  const transport = new FakeTransport(server);
  transport.permission = "edit";
  const backend = fakeBackend(transport, { userId: "u1", name: "Ada" });
  const editor = new EditorController({
    designId: "harness",
    exitHref: "/",
    backend,
    pendingStore: new MemoryPendingStore(),
    extensions: BUILTIN_EXTENSIONS,
  });
  await editor.start();
  const w = window as unknown as Record<string, unknown>;
  w.__canvas = {
    editor,
    ids,
    server,
    nodeCount: Object.keys(design.nodes).length,
    controller: () => canvasControllerOf(editor),
  };
  createRoot(document.getElementById("root") as HTMLElement).render(
    <DesynProvider
      theme={(params.get("theme") as "dark" | "light" | null) ?? "dark"}
      storageKey={null}
    >
      <EditorProvider editor={editor}>
        <Shell />
      </EditorProvider>
    </DesynProvider>,
  );
}

void main();
