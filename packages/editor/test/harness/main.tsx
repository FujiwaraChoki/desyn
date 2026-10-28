import {
  type Animation,
  createChart,
  createDesign,
  createEllipse,
  createImage,
  createPage,
  createQr,
  createRect,
  createText,
  type Design,
  defaultParagraph,
  defaultTextStyle,
  type Id,
  type Node,
  newId,
  type PageNode,
  solid,
} from "@desyn/schema";
import { DesynProvider, toast } from "@desyn/ui";
import { createRoot } from "react-dom/client";
import type { CommentThread, PresenceRow } from "../../src/collab/backend.ts";
import { createCollabExtension } from "../../src/collab/index.ts";
import { collabOf } from "../../src/collab/state.ts";
import { EditorProvider } from "../../src/context.tsx";
import { EditorController } from "../../src/controller.ts";
import { importFile } from "../../src/export/import/run.ts";
import { createExportExtension } from "../../src/export/index.ts";
import { BUILTIN_EXTENSIONS } from "../../src/extensions.ts";
import { startPresenting } from "../../src/present/index.ts";
import { Shell } from "../../src/shell/shell.tsx";
import { MemoryPendingStore } from "../../src/sync/pending-store.ts";
import { FakeCollab, FakeExports } from "../collab/fake-collab.ts";
import { samplePptx } from "../export/pptx-sample.ts";
import { FakeServer, FakeTransport, fakeBackend } from "../fake-server.ts";

// ---------------------------------------------------------------------------------------------------------
// Sample presentation (3 slides with animations, transitions, notes, a chart, an image and a QR code)

const W = 1280;
const H = 720;

function photo(): Promise<{ url: string; bytes: number }> {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 600;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 600);
  grad.addColorStop(0, "#ffd66b");
  grad.addColorStop(0.55, "#ff6a1f");
  grad.addColorStop(1, "#2a0e05");
  g.fillStyle = grad;
  g.fillRect(0, 0, 800, 600);
  g.fillStyle = "rgba(255,240,200,0.9)";
  g.beginPath();
  g.arc(400, 360, 120, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#1a0a04";
  g.fillRect(0, 420, 800, 180);
  return new Promise((resolve) =>
    c.toBlob(
      (b) => resolve({ url: URL.createObjectURL(b as Blob), bytes: (b as Blob).size }),
      "image/png",
    ),
  );
}

const anim = (over: Partial<Animation>): Animation => ({
  id: newId(),
  preset: "rise",
  phase: "in",
  startMs: 0,
  durationMs: 700,
  easing: "ease-out",
  ...over,
});

function text(
  parent: Id,
  s: string,
  over: Partial<Node> & { size?: number; color?: string; family?: string; italic?: boolean } = {},
) {
  const {
    size = 32,
    color = "#ededed",
    family = "Instrument Sans",
    italic = false,
    ...rest
  } = over;
  return createText({
    parent,
    runs: [{ text: s }],
    style: defaultTextStyle({
      fontFamily: family,
      fontSize: size,
      fills: [solid(color)],
      fontStyle: italic ? "italic" : "normal",
    }),
    paragraph: defaultParagraph(),
    autoResize: "height",
    width: 900,
    height: Math.round(size * 1.25),
    ...rest,
  } as never);
}

async function sampleDesign(): Promise<{ design: Design; ids: Record<string, Id> }> {
  const base = createDesign("presentation");
  const p1 = (base.nodes.root as Node & { children: Id[] }).children[0] as Id;
  const p2 = newId();
  const p3 = newId();
  const img = await photo();
  const assetId = newId();
  const nodes: Node[] = [];
  const page = (id: Id, name: string, extra: Partial<PageNode>) =>
    createPage({ id, name, width: W, height: H, background: [solid("#0b0907")], ...extra });

  const sun = createEllipse({
    parent: p1,
    name: "Sun",
    x: 860,
    y: 140,
    width: 300,
    height: 300,
    fills: [solid("#ffb02e")],
    effects: [{ type: "glow", radius: 60, strength: 0.8, color: "#ff6a1f" }],
    anim: [anim({ preset: "zoom-in", durationMs: 900 })],
  } as never);
  const title = text(p1, "Golden hour", {
    name: "Headline",
    family: "Instrument Serif",
    size: 120,
    color: "#ffb02e",
    x: 96,
    y: 210,
    width: 760,
    height: 150,
    anim: [anim({ startMs: 200 })],
  } as never);
  const sub = text(p1, "A launch plan for the autumn collection", {
    name: "Subhead",
    size: 30,
    color: "#d8d2c6",
    x: 100,
    y: 380,
    width: 700,
    height: 40,
    anim: [anim({ preset: "fade", startMs: 600, durationMs: 600 })],
  } as never);
  const card = createRect({
    parent: p1,
    name: "Badge",
    x: 100,
    y: 520,
    width: 220,
    height: 56,
    cornerRadius: 28,
    fills: [solid("#ffb02e26")],
    strokes: [
      { fills: [solid("#ffb02e")], width: 1.5, align: "inside", cap: "butt", join: "miter" },
    ],
    anim: [anim({ preset: "pulse", phase: "loop", startMs: 1400, durationMs: 1800 })],
  } as never);
  const badgeText = text(p1, "Q4 · 2026", {
    name: "Badge label",
    size: 22,
    color: "#ffb02e",
    x: 140,
    y: 534,
    width: 160,
    height: 28,
  } as never);

  const photoNode = createImage({
    parent: p2,
    name: "Sunset photo",
    assetId,
    x: 640,
    y: 0,
    width: 640,
    height: 720,
    fit: "crop",
    crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
    anim: [anim({ preset: "slide-left", durationMs: 800 })],
  } as never);
  const h2 = text(p2, "Three moments", {
    name: "Title",
    family: "Instrument Serif",
    size: 72,
    color: "#ededed",
    x: 80,
    y: 80,
    width: 520,
    height: 90,
  } as never);
  const chart = createChart({
    parent: p2,
    name: "Reach chart",
    x: 80,
    y: 220,
    width: 500,
    height: 360,
    anim: [anim({ preset: "rise", startMs: 300 })],
  } as never);

  const thanks = text(p3, "thank you", {
    name: "Thanks",
    family: "Instrument Serif",
    italic: true,
    size: 140,
    color: "#ffb02e",
    x: 140,
    y: 230,
    width: 800,
    height: 180,
    anim: [
      anim({ preset: "blur-in", durationMs: 900 }),
      anim({ preset: "fade", phase: "out", startMs: 4000, durationMs: 500 }),
    ],
  } as never);
  const qr = createQr({
    parent: p3,
    name: "Link",
    data: "https://desyn.app",
    fg: "#0b0907",
    bg: "#ffb02e",
    x: 980,
    y: 460,
    width: 180,
    height: 180,
  } as never);

  nodes.push(sun, title, sub, card, badgeText, photoNode, h2, chart, thanks, qr);
  const byParent = (p: Id) => nodes.filter((n) => n.parent === p).map((n) => n.id);
  const design: Design = {
    ...base,
    name: "Autumn launch",
    assets: {
      [assetId]: {
        id: assetId,
        kind: "image",
        mime: "image/png",
        width: 800,
        height: 600,
        url: img.url,
        bytes: img.bytes,
      },
    },
    nodes: {
      root: { ...(base.nodes.root as Node), children: [p1, p2, p3] } as Node,
      [p1]: page(p1, "Cover", {
        children: byParent(p1),
        notes: "Welcome everyone. Thirty seconds on why autumn matters.",
      } as never),
      [p2]: page(p2, "Moments", {
        children: byParent(p2),
        transition: { kind: "push", durationMs: 700 },
        notes: "Walk through the three campaign moments.",
      } as never),
      [p3]: page(p3, "Thanks", {
        children: byParent(p3),
        transition: { kind: "zoom", durationMs: 600 },
        notes: "Open for questions.",
      } as never),
      ...Object.fromEntries(nodes.map((n) => [n.id, n])),
    },
  };
  return {
    design,
    ids: {
      p1,
      p2,
      p3,
      title: title.id,
      sun: sun.id,
      card: card.id,
      chart: chart.id,
      photo: photoNode.id,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------

async function main() {
  const { design, ids } = await sampleDesign();
  const server = new FakeServer(design);
  const transport = new FakeTransport(server);
  transport.permission = "manage";
  const backend = fakeBackend(transport, { userId: "user1", name: "Ada Lovelace" });
  backend.assets.designUrls = async () => ({
    urls: Object.fromEntries(
      Object.values(server.design.assets)
        .filter((a) => a.url)
        .map((a) => [a.id, a.url as string]),
    ),
    expiresAt: null,
  });

  const collab = new FakeCollab();
  const exportsBackend = new FakeExports();
  exportsBackend.accountCell.set({
    userId: "user1",
    plan: "pro",
    edition: "hosted",
    features: Object.fromEntries(
      [
        "export.png",
        "export.jpg",
        "export.webp",
        "export.svg",
        "export.pdf",
        "export.pdfPrint",
        "export.pptx",
        "export.video",
        "collab.comments",
        "versionHistory",
        "teams",
        "share.viewLink",
        "share.editLink",
      ].map((k) => [k, true]),
    ),
  });

  const editor = new EditorController({
    designId: "d1",
    exitHref: "/",
    backend,
    pendingStore: new MemoryPendingStore(),
    extensions: [
      ...BUILTIN_EXTENSIONS.filter((e) => e.id !== "collab" && e.id !== "export"),
      createCollabExtension({ backend: () => collab }),
      createExportExtension({ backend: () => exportsBackend }),
    ],
    notify: (n) => {
      const opts = n.description ? { description: n.description } : {};
      if (n.kind === "error") toast.error(n.title, opts);
      else if (n.kind === "success") toast.success(n.title, opts);
      else toast(n.title, opts);
    },
  });

  // Uploads (images / PDF pages / PowerPoint pictures) stay in the page as object URLs.
  editor.assets.upload = async (file: File | Blob, name?: string) => {
    const url = URL.createObjectURL(file);
    const mime = file.type || "image/png";
    let width: number | undefined;
    let height: number | undefined;
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      const bmp = await createImageBitmap(file);
      width = bmp.width;
      height = bmp.height;
      bmp.close();
    }
    const ref = {
      id: newId(),
      kind: mime === "image/svg+xml" ? ("svg" as const) : ("image" as const),
      mime,
      url,
      bytes: file.size,
      ...(width ? { width, height } : {}),
      name: name ?? "upload",
    };
    editor.assets.prime(ref.id, url);
    return { ref, url, deduplicated: false, assetId: ref.id };
  };

  await editor.start();

  // Collaborators ------------------------------------------------------------------------------------------
  const now = () => Date.now();
  const people: PresenceRow[] = [
    {
      sessionId: "mira00000001",
      userId: "u-mira",
      name: "Mira Okafor",
      image: null,
      color: "#4dabf7",
      cursor: { x: 640, y: 300, pageId: ids.p1 },
      selection: [ids.title as Id],
      viewport: { x: -100, y: -60, zoom: 0.75, width: 1400, height: 820, pageId: ids.p1 },
      drag: null,
      editing: null,
      expiresAt: now() + 60_000,
      updatedAt: now(),
    },
    {
      sessionId: "jonas0000001",
      userId: "u-jonas",
      name: "Jonas Weber",
      image: null,
      color: "#51cf66",
      cursor: { x: 1000, y: 560, pageId: ids.p1 },
      selection: [ids.card as Id],
      viewport: { x: 400, y: 100, zoom: 1.5, width: 1200, height: 800, pageId: ids.p1 },
      drag: null,
      editing: { nodeIds: [ids.card as Id], kind: "text" },
      expiresAt: now() + 60_000,
      updatedAt: now() - 2000,
    },
    {
      sessionId: "sora00000001",
      userId: "u-sora",
      name: "Sora Kim",
      image: null,
      color: "#da77f2",
      cursor: { x: 300, y: 600, pageId: ids.p2 },
      selection: [],
      viewport: null,
      drag: null,
      editing: null,
      expiresAt: now() + 60_000,
      updatedAt: now() - 4000,
    },
  ];
  let tick = 0;
  const move = () => {
    tick++;
    const t = tick / 10;
    collab.rows.set(
      people.map((p, i) => ({
        ...p,
        cursor:
          p.cursor && i < 2
            ? {
                ...p.cursor,
                x: p.cursor.x + Math.cos(t + i) * 60,
                y: p.cursor.y + Math.sin(t * 1.3 + i) * 40,
              }
            : p.cursor,
        expiresAt: now() + 60_000,
      })),
    );
  };
  move();
  const params = new URLSearchParams(location.search);
  if (!params.has("still")) setInterval(move, 150);

  collab.people = [
    { id: "u-mira", name: "Mira Okafor", image: null, role: "editor" },
    { id: "u-jonas", name: "Jonas Weber", image: null, role: "commenter" },
    { id: "user1", name: "Ada Lovelace", image: null, role: "owner" },
  ];
  const ago = (m: number) => now() - m * 60_000;
  const mira = { id: "u-mira", name: "Mira Okafor", image: null };
  const jonas = { id: "u-jonas", name: "Jonas Weber", image: null };
  const ada = { id: "user1", name: "Ada Lovelace", image: null };
  const threads: CommentThread[] = [
    {
      id: "t1",
      threadId: null,
      body: "Can the headline breathe a little more? It feels tight against the sun.",
      deleted: false,
      author: mira,
      mentions: [],
      createdAt: ago(95),
      editedAt: null,
      nodeId: ids.title as Id,
      pageId: ids.p1 as Id,
      x: 620,
      y: 20,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      lastActivityAt: ago(4),
      replies: [
        {
          id: "r1",
          threadId: "t1",
          body: "@Ada Lovelace agree, maybe 24 px more tracking room?",
          deleted: false,
          author: jonas,
          mentions: ["user1"],
          createdAt: ago(4),
          editedAt: null,
        },
      ],
    },
    {
      id: "t2",
      threadId: null,
      body: "Love this glow. Keep it for the whole deck.",
      deleted: false,
      author: jonas,
      mentions: [],
      createdAt: ago(60),
      editedAt: null,
      nodeId: ids.sun as Id,
      pageId: ids.p1 as Id,
      x: 260,
      y: 40,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      lastActivityAt: ago(60),
      replies: [],
    },
    {
      id: "t3",
      threadId: null,
      body: "Chart needs a source line.",
      deleted: false,
      author: ada,
      mentions: [],
      createdAt: ago(300),
      editedAt: null,
      nodeId: ids.chart as Id,
      pageId: ids.p2 as Id,
      x: 480,
      y: 20,
      resolved: true,
      resolvedBy: mira,
      resolvedAt: ago(200),
      lastActivityAt: ago(200),
      replies: [],
    },
    {
      id: "t4",
      threadId: null,
      body: "Swap for the beach shot from Friday?",
      deleted: false,
      author: mira,
      mentions: [],
      createdAt: ago(30),
      editedAt: null,
      nodeId: null,
      pageId: ids.p2 as Id,
      x: 900,
      y: 120,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      lastActivityAt: ago(30),
      replies: [],
    },
  ];
  collab.threads.set(threads);
  collab.comments.create = async (c) => {
    const id = `t${threads.length + 1}`;
    threads.unshift({
      id,
      threadId: null,
      body: c.body,
      deleted: false,
      author: ada,
      mentions: c.mentions,
      createdAt: now(),
      editedAt: null,
      nodeId: c.nodeId ?? null,
      pageId: c.pageId ?? null,
      x: c.x ?? null,
      y: c.y ?? null,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      lastActivityAt: now(),
      replies: [],
    });
    collab.threads.set([...threads]);
    return id;
  };
  collab.comments.reply = async (threadId, body, mentions) => {
    const t = threads.find((x) => x.id === threadId);
    if (t) {
      t.replies = [
        ...t.replies,
        {
          id: newId(),
          threadId,
          body,
          deleted: false,
          author: ada,
          mentions,
          createdAt: now(),
          editedAt: null,
        },
      ];
      t.lastActivityAt = now();
      t.resolved = false;
    }
    collab.threads.set([...threads]);
    return "r";
  };
  collab.comments.resolve = async (threadId, resolved) => {
    const t = threads.find((x) => x.id === threadId);
    if (t)
      Object.assign(t, {
        resolved,
        resolvedBy: resolved ? ada : null,
        resolvedAt: resolved ? now() : null,
      });
    collab.threads.set([...threads]);
  };

  collab.memberList.set([
    {
      userId: "user1",
      role: "owner",
      name: "Ada Lovelace",
      email: "ada@studio.example",
      image: null,
      isYou: true,
      joinedAt: ago(9000),
    },
    {
      userId: "u-mira",
      role: "editor",
      name: "Mira Okafor",
      email: "mira@studio.example",
      image: null,
      isYou: false,
      joinedAt: ago(8000),
    },
    {
      userId: "u-jonas",
      role: "commenter",
      name: "Jonas Weber",
      email: "jonas@studio.example",
      image: null,
      isYou: false,
      joinedAt: ago(7000),
    },
  ]);
  collab.links.set([
    {
      id: "s1",
      token: "q7sun2k9lm3x",
      url: "https://app.desyn.app/share/q7sun2k9lm3x",
      permission: "view",
      hasPassword: false,
      expiresAt: null,
      expired: false,
      label: "Client preview",
      createdBy: "user1",
      createdAt: ago(3000),
      lastUsedAt: ago(40),
    },
    {
      id: "s2",
      token: "p0edit5ab7yz",
      url: "https://app.desyn.app/share/p0edit5ab7yz",
      permission: "edit",
      hasPassword: true,
      expiresAt: now() + 6 * 86_400_000,
      expired: false,
      label: null,
      createdBy: "user1",
      createdAt: ago(600),
      lastUsedAt: null,
    },
  ]);
  const version = (
    id: string,
    name: string,
    auto: boolean,
    mins: number,
    status: "ready" | "pending" = "ready",
  ) => ({
    id,
    name,
    seq: 10,
    status,
    auto,
    pageCount: 3,
    createdBy: "user1",
    createdByName: auto ? null : "Ada Lovelace",
    createdAt: ago(mins),
    error: null,
  });
  collab.versionList.set([
    version("v5", "Autosave", true, 3, "pending"),
    version("v4", "Before client call", false, 40),
    version("v3", "Autosave", true, 75),
    version("v2", "First draft", false, 60 * 26),
    version("v1", "Autosave", true, 60 * 30),
  ]);
  collab.versions.get = async () => {
    const older = structuredClone(server.design);
    const node = older.nodes[ids.title as Id] as Node & { runs: { text: string }[] };
    node.runs = [{ text: "Golden hours" }];
    const sunNode = older.nodes[ids.sun as Id] as Node & { fills: unknown };
    sunNode.fills = [solid("#ff6a1f")];
    return { design: JSON.stringify(older), name: "Before client call" };
  };

  // Server exports progress queued -> rendering -> ready.
  const request = exportsBackend.request.bind(exportsBackend);
  exportsBackend.request = async (args) => {
    const id = await request(args);
    const cell = exportsBackend.jobs.get(id);
    setTimeout(() => cell?.set({ ...cell.value, status: "rendering", startedAt: now() }), 1200);
    setTimeout(async () => {
      const file = await photo();
      cell?.set({
        ...cell.value,
        status: "ready",
        finishedAt: now(),
        files: [
          {
            pageId: null,
            fileName: `Autumn launch.${args.format}`,
            contentType: "video/mp4",
            bytes: 4_200_000,
            url: file.url,
          },
        ],
      });
    }, 3200);
    return id;
  };

  const w = window as unknown as Record<string, unknown>;
  w.__harness = {
    editor,
    collab,
    exportsBackend,
    ids,
    collabStore: () => collabOf(editor)?.store,
    present: (presenterView = false) => startPresenting(editor, { fromStart: true, presenterView }),
    importPptx: async () => {
      const png = await (await fetch((await photo()).url)).arrayBuffer();
      const file = new File(
        [samplePptx(new Uint8Array(png)) as BlobPart],
        "Quarterly review.pptx",
        { type: "" },
      );
      return importFile(editor, file, { onUpdate: () => {} });
    },
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
