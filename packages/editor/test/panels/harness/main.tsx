import {
  createDesign,
  createImage,
  createText,
  type Design,
  defaultTextStyle,
} from "@desyn/schema";
import { DesynProvider, toast } from "@desyn/ui";
import { createRoot } from "react-dom/client";
import { canvasExtension } from "../../../src/canvas/index.ts";
import { builtinToolDefs } from "../../../src/commands/tools.ts";
import { EditorProvider } from "../../../src/context.tsx";
import { EditorController } from "../../../src/controller.ts";
import { panelsExtension } from "../../../src/panels/index.ts";
import { defineExtension } from "../../../src/shell/extensions.ts";
import { Shell } from "../../../src/shell/shell.tsx";
import { ShortcutsDialog } from "../../../src/shell/shortcuts-dialog.tsx";
import { MemoryPendingStore } from "../../../src/sync/pending-store.ts";
import { pageIdOf, withNodes } from "../../editor-helpers.ts";
import { FakeServer, FakeTransport, fakeBackend } from "../../fake-server.ts";
import { FakeConvex, page } from "../fake-convex.ts";
import { harnessDesign } from "./fixture.ts";
import "./styles.css";

/**
 * Screenshot harness for the panels: the real editor shell, engine (wasm worker), canvas and panels
 * extensions over the in-memory backend of the tests and a FakeConvex serving templates, brand kits,
 * uploads and stock photos. Not shipped; driven by shots.mjs (Playwright).
 */

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
localStorage.setItem("desyn-theme", JSON.stringify(theme));

const IMAGES = {
  sunset000001: "/sunset.jpg",
  abstract0001: "/abstract.jpg",
  portrait0001: "/portrait.jpg",
};

function templateDesign(): Design {
  let t = createDesign("social-post");
  const p = pageIdOf(t);
  t = withNodes(t, p, [
    createImage({
      parent: p,
      assetId: "sunset000001",
      width: 1080,
      height: 720,
      name: "Hero photo",
    }),
    createText({
      parent: p,
      text: "Sunday market",
      x: 72,
      y: 780,
      width: 900,
      height: 100,
      role: "headline",
      style: defaultTextStyle({ fontFamily: "Instrument Serif", fontSize: 92 }),
    }),
  ]);
  return {
    ...t,
    assets: {
      sunset000001: {
        id: "sunset000001",
        kind: "image",
        mime: "image/jpeg",
        width: 1600,
        height: 1067,
      },
    },
  };
}

const TEMPLATES = (
  [
    ["Sunset sale", "/sunset.jpg", 1, false],
    ["Ember quote", "/abstract.jpg", 1, false],
    ["Portrait story", "/portrait.jpg", 3, true],
    ["Golden menu", "/sunset.jpg", 2, false],
    ["Warm gradient", "/abstract.jpg", 1, true],
    ["Studio profile", "/portrait.jpg", 1, false],
  ] as [string, string, number, boolean][]
).map(([title, url, pages, premium], i) => ({
  id: `tpl${i}`,
  slug: `tpl-${i}`,
  title,
  description: "",
  kind: "social-post",
  category: i % 2 ? "minimal" : "bold",
  categories: [],
  tags: [],
  premium,
  pageCount: pages,
  width: 1080,
  height: i === 2 ? 1920 : 1080,
  thumbnails: [{ url, width: 540, height: i === 2 ? 960 : 540 }],
  favorite: i === 1,
}));

const asset = (
  id: string,
  name: string,
  kind: string,
  url: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  refId: id.padEnd(12, "0").slice(0, 12),
  kind,
  name,
  mime: kind === "font" ? "font/ttf" : "image/jpeg",
  bytes: 70_000,
  width: 1600,
  height: 1000,
  durationMs: null,
  hash: id,
  storageKey: `uploads/ws1/${id}/${name}`,
  source: "upload",
  family: null,
  weight: null,
  style: null,
  url,
  ...extra,
});

const ASSETS = [
  asset("upsunset", "sunset.jpg", "image", "/sunset.jpg"),
  asset("upabstract", "ember-texture.jpg", "image", "/abstract.jpg"),
  asset("upportrait", "portrait.jpg", "image", "/portrait.jpg", { width: 1080, height: 1350 }),
  asset("upfont", "Instrument Serif.ttf", "font", null, { family: "Instrument Serif" }),
];

const STOCK = [
  "/sunset.jpg",
  "/abstract.jpg",
  "/portrait.jpg",
  "/abstract.jpg",
  "/sunset.jpg",
  "/portrait.jpg",
].map((url, i) => ({
  id: `unsplash:demo${i}`,
  provider: i % 3 === 2 ? "pexels" : "unsplash",
  description: ["warm sunset over hills", "ember abstract", "studio portrait"][i % 3],
  width: i % 3 === 2 ? 1080 : 1600,
  height: i % 3 === 2 ? 1350 : 1067,
  thumbUrl: url,
  url,
  author: ["Mara Solis", "Ken Ito", "Ada Brook"][i % 3],
  authorUrl: "https://unsplash.com",
  sourceUrl: "https://unsplash.com",
  license: "Unsplash License",
}));

const folders = [
  { id: "f1", name: "Summer campaign", count: 2, createdAt: 1 },
  { id: "f2", name: "Logos", count: 1, createdAt: 2 },
];

const convex = new FakeConvex({
  "accounts/profiles:me": () => ({
    userId: "user1",
    plan: params.get("plan") ?? "pro",
    planName: "Pro",
    features:
      params.get("plan") === "free"
        ? {
            charts: false,
            tables: false,
            qr: false,
            "templates.premium": false,
            "effects.advanced": false,
          }
        : {},
  }),
  "templates/templates:categories": () => [
    { category: "bold", count: 3 },
    { category: "minimal", count: 3 },
    { category: "sale", count: 2 },
    { category: "quote", count: 1 },
  ],
  "templates/templates:list": (args) => page(TEMPLATES, args),
  "templates/templates:search": (args) =>
    page(
      TEMPLATES.filter((t) => t.title.toLowerCase().includes(String(args.query).toLowerCase())),
      args,
    ),
  "templates/templates:getDesign": () => ({ design: JSON.stringify(templateDesign()) }),
  "templates/templates:favorite": () => null,
  "brand/brandKits:list": () => [
    {
      id: "kit1",
      workspaceId: "ws1",
      name: "Desyn Sun",
      logos: [
        {
          id: "l1",
          assetId: "upsunset",
          name: "Sun mark",
          variant: "icon",
          refId: "upsunset0000",
          mime: "image/jpeg",
          width: 1600,
          height: 1000,
          url: "/sunset.jpg",
        },
        {
          id: "l2",
          assetId: "upportrait",
          name: "Wordmark",
          variant: "wordmark",
          refId: "upportrait00",
          mime: "image/jpeg",
          width: 1080,
          height: 1350,
          url: "/portrait.jpg",
        },
      ],
      colors: [
        { id: "c1", name: "Sun", value: "#ffb02e", role: "primary" },
        { id: "c2", name: "Ember", value: "#ff6a1f", role: "secondary" },
        { id: "c3", name: "Dawn", value: "#ffd66b", role: "accent" },
        { id: "c4", name: "Rust", value: "#c4451c", role: "other" },
        { id: "c5", name: "Night", value: "#0a0a0a", role: "text" },
        { id: "c6", name: "Paper", value: "#faf8f4", role: "background" },
      ],
      fonts: {
        heading: {
          family: "Instrument Serif",
          weight: 400,
          style: "normal",
          url: null,
          refId: null,
        },
        body: { family: "Inter", weight: 400, style: "normal", url: null, refId: null },
        accent: { family: "JetBrains Mono", weight: 500, style: "normal", url: null, refId: null },
      },
      voice: {
        tone: "Calm, precise, warm.",
        description: "",
        keywords: ["light", "craft", "clarity"],
        avoid: [],
      },
      rules: [],
      isDefault: true,
    },
  ],
  "assets/assets:list": (args) =>
    page(
      ASSETS.filter((a) => !args.kind || a.kind === args.kind),
      args,
    ),
  "assets/assets:get": (args) => ASSETS.find((a) => a.id === args.assetId) ?? ASSETS[0],
  "assets/assets:rename": () => null,
  "assets/assets:delete": () => null,
  "panels/assetFolders:list": () => folders,
  "panels/assetFolders:create": (args) => {
    folders.push({
      id: `f${folders.length + 1}`,
      name: String(args.name),
      count: 0,
      createdAt: Date.now(),
    });
    return folders[folders.length - 1]?.id;
  },
  "panels/assetFolders:assets": (args) => page(ASSETS.slice(0, 2), args),
  "panels/assetFolders:move": () => null,
  "stock/photos:search": () => {
    // `?stock=off`: a server without provider keys answers NOT_CONFIGURED.
    if (params.get("stock") === "off") {
      throw Object.assign(new Error("Stock photo search is not configured."), {
        data: { code: "NOT_CONFIGURED", message: "Stock photo search is not configured." },
      });
    }
    return { photos: STOCK, hasMore: true };
  },
  "panels/stock:use": () => ({ asset: ASSETS[0] }),
});

// The shell's own contributions (src/extensions.ts `coreExtension`), rebuilt here so the harness does not
// load the other feature extensions (AI, collaboration, export) while their owners are editing them.
const MENU: [string, number][] = [
  ["edit.cut", 10],
  ["edit.copy", 11],
  ["edit.paste", 12],
  ["edit.pasteInPlace", 13],
  ["edit.duplicate", 14],
  ["-", 19],
  ["arrange.bringToFront", 20],
  ["arrange.bringForward", 21],
  ["arrange.sendBackward", 22],
  ["arrange.sendToBack", 23],
  ["-", 29],
  ["edit.group", 30],
  ["edit.ungroup", 31],
  ["edit.frameSelection", 32],
  ["edit.autoLayout", 33],
  ["edit.useAsMask", 34],
  ["-", 39],
  ["edit.flipHorizontal", 40],
  ["edit.flipVertical", 41],
  ["edit.toggleLock", 42],
  ["edit.toggleVisibility", 43],
  ["edit.rename", 44],
  ["-", 49],
  ["edit.copyStyle", 50],
  ["edit.pasteStyle", 51],
  ["edit.copyAsPng", 52],
  ["-", 89],
  ["edit.delete", 90],
];
const coreExtension = defineExtension({
  id: "core",
  setup(api) {
    for (const tool of builtinToolDefs()) api.registerTool(tool);
    api.registerModal({ id: "shortcuts", component: ShortcutsDialog });
    api.registerContextMenu(
      MENU.map(([command, order]) => ({ command, order, target: "selection" as const })),
    );
  },
});

const { design } = harnessDesign();
const server = new FakeServer(design);
const transport = new FakeTransport(server);
transport.permission = "edit";
const backend = fakeBackend(transport);
backend.assets.designUrls = async () => ({
  urls: { ...IMAGES, upsunset0000: "/sunset.jpg", upportrait00: "/portrait.jpg" },
  expiresAt: null,
});

const editor = new EditorController({
  designId: "d1",
  exitHref: "/",
  backend,
  convex: convex.asClient(),
  pendingStore: new MemoryPendingStore(),
  extensions: [coreExtension, canvasExtension, panelsExtension],
  navigate: () => {},
  notify: (n) => (n.kind === "error" ? toast.error(n.title) : toast.info(n.title)),
});
Object.defineProperty(editor.sync, "loadHeader", {
  get: () => ({ workspaceId: "ws1", designId: "d1", permission: "edit" }),
});
(window as unknown as { __editor: EditorController }).__editor = editor;

// Vite may re-run this module after optimizing dependencies; keep one root per document.
const host = window as unknown as { __harnessRoot?: ReturnType<typeof createRoot> };
host.__harnessRoot ??= createRoot(document.getElementById("root") as HTMLElement);
host.__harnessRoot.render(
  <DesynProvider theme={theme}>
    <EditorProvider editor={editor}>
      <Shell />
    </EditorProvider>
  </DesynProvider>,
);
void editor.start();
