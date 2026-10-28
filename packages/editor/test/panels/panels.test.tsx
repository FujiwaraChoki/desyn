import { pages } from "@desyn/doc-ops";
import {
  type ChartNode,
  createDesign,
  createRect,
  createText,
  type Design,
  defaultParagraph,
  defaultTextStyle,
  type Node,
  type PageNode,
  type TextNode,
} from "@desyn/schema";
import { DesynProvider } from "@desyn/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorProvider } from "../../src/context.tsx";
import { EditorController } from "../../src/controller.ts";
import { coreExtension } from "../../src/extensions.ts";
import { panelsExtension } from "../../src/panels/index.ts";
import { Shell } from "../../src/shell/shell.tsx";
import { MemoryPendingStore } from "../../src/sync/pending-store.ts";
import { pageIdOf, withNodes } from "../editor-helpers.ts";
import { FakeServer, FakeTransport, fakeBackend, until } from "../fake-server.ts";
import { FakeConvex, page } from "./fake-convex.ts";

const noEngine = {
  createClient: () => Promise.reject(new Error("OffscreenCanvas is not available in this browser")),
};

function baseDesign(): Design {
  let d = createDesign("social-post");
  const p = pageIdOf(d);
  d = withNodes(d, p, [
    createRect({
      parent: p,
      name: "Hero card",
      x: 100,
      y: 100,
      width: 200,
      height: 120,
      role: "card",
    }),
  ]);
  return { ...d, name: "Launch post" };
}

interface Mounted {
  editor: EditorController;
  server: FakeServer;
  convex: FakeConvex;
}

const templateDesign = (() => {
  let t = createDesign("social-post");
  const p = pageIdOf(t);
  t = withNodes(t, p, [
    createRect({ parent: p, name: "Template block", fills: [{ type: "solid", color: "#ff6a1f" }] }),
  ]);
  return t;
})();

function convexHandlers(state: { assets: unknown[]; deleted: string[] }) {
  return {
    "accounts/profiles:me": () => ({
      userId: "user1",
      plan: "pro",
      planName: "Pro",
      features: { charts: true, tables: true, qr: true },
    }),
    "templates/templates:categories": () => [{ category: "minimal", count: 1 }],
    "templates/templates:list": (args: Record<string, unknown>) =>
      page(
        [
          {
            id: "tpl1",
            slug: "sunrise",
            title: "Sunrise launch",
            description: "",
            kind: "social-post",
            category: "minimal",
            categories: ["minimal"],
            tags: [],
            premium: false,
            pageCount: 1,
            width: 1080,
            height: 1080,
            thumbnails: [{ url: null, width: 540, height: 540 }],
            favorite: false,
          },
        ],
        args,
      ),
    "templates/templates:search": (args: Record<string, unknown>) => page([], args),
    "templates/templates:getDesign": () => ({ design: JSON.stringify(templateDesign) }),
    "brand/brandKits:list": () => [
      {
        id: "kit1",
        workspaceId: "ws1",
        name: "Sun Co",
        logos: [],
        colors: [
          { id: "c1", name: "Sun", value: "#ffb02e", role: "primary" },
          { id: "c2", name: "Paper", value: "#faf8f4", role: "background" },
        ],
        fonts: {
          heading: { family: "Fraunces", weight: 600, style: "normal", url: null, refId: null },
        },
        voice: null,
        rules: [],
        isDefault: true,
      },
    ],
    "assets/assets:list": (args: Record<string, unknown>) =>
      page(
        state.assets.filter((a) => !state.deleted.includes((a as { id: string }).id)),
        args,
      ),
    "assets/assets:delete": (args: Record<string, unknown>) => {
      state.deleted.push(String(args.assetId));
      return null;
    },
    "panels/assetFolders:list": () => [{ id: "f1", name: "Campaign", count: 0, createdAt: 1 }],
    "stock/photos:search": () => {
      throw Object.assign(new Error("Stock photo search is not configured."), {
        data: { code: "NOT_CONFIGURED", message: "Stock photo search is not configured." },
      });
    },
  };
}

async function mount(
  design: Design = baseDesign(),
  overrides: Record<string, (args: Record<string, unknown>) => unknown> = {},
): Promise<Mounted> {
  const server = new FakeServer(design);
  const transport = new FakeTransport(server);
  transport.permission = "edit";
  const backend = fakeBackend(transport);
  const state = {
    assets: [
      {
        id: "asset1",
        refId: "upload000001",
        kind: "image",
        name: "beach.jpg",
        mime: "image/jpeg",
        bytes: 1000,
        width: 1600,
        height: 900,
        durationMs: null,
        hash: "h",
        storageKey: "uploads/ws1/upload000001/beach.jpg",
        source: "upload",
        family: null,
        weight: null,
        style: null,
        url: "https://example.invalid/beach.jpg",
      },
    ],
    deleted: [] as string[],
  };
  const convex = new FakeConvex({ ...convexHandlers(state), ...overrides });
  const editor = new EditorController({
    designId: "d1",
    exitHref: "/",
    backend,
    convex: convex.asClient(),
    pendingStore: new MemoryPendingStore(),
    extensions: [coreExtension, panelsExtension],
    engine: noEngine,
    navigate: () => {},
    sync: { retry: { baseMs: 1, maxMs: 4 }, random: () => 1 },
  });
  // The fake load header has no workspace; the panels read it from there.
  Object.defineProperty(editor.sync, "loadHeader", {
    get: () => ({ workspaceId: "ws1", designId: "d1", permission: "edit" }),
  });
  render(
    <DesynProvider>
      <EditorProvider editor={editor}>
        <Shell />
      </EditorProvider>
    </DesynProvider>,
  );
  await act(async () => {
    await editor.start();
  });
  await until(() => editor.design !== null);
  await screen.findByRole("button", { name: "Launch post" });
  return { editor, server, convex };
}

const nodesOf = (d: Design | null) => Object.values(d?.nodes ?? {});
const pageOf = (editor: EditorController) => editor.currentPage() as PageNode;

beforeEach(() => {
  // jsdom has no layout: give elements a box so virtualized lists (layers tree) render rows.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 320, 600),
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  // Iconify is the only network the panels reach directly; answer it locally.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/search")) {
        return new Response(JSON.stringify({ icons: ["lucide:sun", "lucide:star"] }), {
          status: 200,
        });
      }
      // Icon bodies per set (`/lucide.json?icons=sun,star`).
      const body = '<circle cx="12" cy="12" r="5" fill="currentColor"/>';
      return new Response(
        JSON.stringify({
          prefix: "lucide",
          width: 24,
          height: 24,
          icons: { sun: { body }, star: { body } },
        }),
        { status: 200 },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("panels extension", () => {
  test("registers the rail, inspector tabs, pages strip, dialogs and commands", async () => {
    const { editor } = await mount();
    const nav = screen.getByRole("navigation", { name: "Panels" });
    for (const label of [
      "Design",
      "Elements",
      "Text",
      "Brand",
      "Uploads",
      "Photos",
      "Layers",
      "Pages",
    ]) {
      expect(within(nav).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(editor.extensions.modals.has("page-resize")).toBe(true);
    expect(editor.extensions.modals.has("chart-data")).toBe(true);
    expect(editor.commands.get("panel.uploads")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Pages" })).toBeTruthy();
    // Nothing selected: the inspector shows the page.
    expect(screen.getByText("Background")).toBeTruthy();
  });

  test("Elements: a shape click inserts it on the page, selected, one undo step", async () => {
    const { editor, server } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Elements",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Circle" }));
    await waitFor(() =>
      expect(nodesOf(editor.design).some((n) => n.type === "ellipse")).toBe(true),
    );
    const circle = nodesOf(editor.design).find((n) => n.type === "ellipse") as Node;
    expect(editor.getState().selection).toEqual([circle.id]);
    expect(circle.parent).toBe(pageOf(editor).id);
    await until(() => nodesOf(server.design).some((n) => n.type === "ellipse"));
    await act(async () => {
      await editor.undo();
    });
    expect(nodesOf(editor.design).some((n) => n.type === "ellipse")).toBe(false);
  });

  test("Elements: icons come from Iconify and land as inline vector layers", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Elements",
      }),
    );
    const icon = await screen.findAllByRole("button", { name: /sun \(Lucide\)/ });
    fireEvent.click(icon[0] as HTMLElement);
    await waitFor(() => expect(nodesOf(editor.design).some((n) => n.type === "svg")).toBe(true));
    const svg = nodesOf(editor.design).find((n) => n.type === "svg") as Node & { markup: string };
    expect(svg.markup).toContain("<svg");
    expect(svg.role).toBe("icon");
  });

  test("Elements: a chart opens its data sheet, and edits reach the chart", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Elements",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Column chart" }));
    expect(await screen.findByRole("heading", { name: /chart data/i })).toBeTruthy();
    const cell = screen.getByRole("textbox", { name: "Series 1, Q1" });
    fireEvent.change(cell, { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      const chart = nodesOf(editor.design).find((n) => n.type === "chart") as ChartNode;
      expect(chart.data.series[0]?.values[0]).toBe(42);
    });
  });

  test("Text: presets add styled text with a role", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Text",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add a heading" }));
    await waitFor(() => expect(nodesOf(editor.design).some((n) => n.type === "text")).toBe(true));
    const t = nodesOf(editor.design).find((n) => n.type === "text") as TextNode;
    expect(t.role).toBe("headline");
    expect(t.style.fontSize).toBe(72);
  });

  test("Layers: tree, hide toggle and search", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Layers",
      }),
    );
    const tree = await screen.findByRole("tree");
    expect(within(tree).getByRole("treeitem", { name: "Hero card" })).toBeTruthy();
    expect(within(tree).getByText("card")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "Hide layer" }));
    await waitFor(() =>
      expect(nodesOf(editor.design).find((n) => n.name === "Hero card")?.visible).toBe(false),
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search layers" }), {
      target: { value: "nothing" },
    });
    expect(await screen.findByText("No layers match the filter.")).toBeTruthy();
  });

  test("Inspector: typed position commits once; the layer header edits the role", async () => {
    const { editor } = await mount();
    const rect = nodesOf(editor.design).find((n) => n.type === "rect") as Node;
    act(() => editor.select([rect.id]));
    const x = await screen.findByRole("spinbutton", { name: "X position" });
    fireEvent.change(x, { target: { value: "300/2" } });
    fireEvent.keyDown(x, { key: "Enter" });
    await waitFor(() => expect(editor.design?.nodes[rect.id]?.x).toBe(150));
    expect(editor.getState().history.undoLabel).toBe("Move");
  });

  test("Inspector: tabs follow the selection", async () => {
    const { editor } = await mount();
    expect(screen.queryByRole("tab", { name: "Arrange" })).toBeNull();
    const rect = nodesOf(editor.design).find((n) => n.type === "rect") as Node;
    act(() => editor.select([rect.id]));
    expect(await screen.findByRole("tab", { name: "Arrange" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Effects" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Animate" })).toBeTruthy();
  });

  test("Pages: add from the strip, resize with a preset", async () => {
    const { editor } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    await waitFor(() => expect(pages(editor.design as Design)).toHaveLength(2));
    act(() => {
      void editor.commands.run("page.resize");
    });
    expect(await screen.findByRole("heading", { name: /resize page/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Instagram story/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resize" }));
    await waitFor(() => expect(pageOf(editor)).toMatchObject({ width: 1080, height: 1920 }));
  });

  test("Design: templates apply as editable layers replacing the page", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Design",
      }),
    );
    const card = await screen.findByRole("button", { name: "Sunrise launch" });
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Replace this page" }));
    await waitFor(() =>
      expect(nodesOf(editor.design).some((n) => n.name === "Template block")).toBe(true),
    );
    expect(nodesOf(editor.design).some((n) => n.name === "Hero card")).toBe(false);
    expect(pages(editor.design as Design)).toHaveLength(1);
  });

  test("Uploads: library items place on the page; folders show", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Uploads",
      }),
    );
    expect(await screen.findByRole("button", { name: /^Campaign\s*0$/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Place beach.jpg" }));
    await waitFor(() => expect(nodesOf(editor.design).some((n) => n.type === "image")).toBe(true));
    expect(editor.design?.assets.upload000001?.storageKey).toBe(
      "uploads/ws1/upload000001/beach.jpg",
    );
    expect(editor.design?.assets.upload000001?.url).toBeUndefined();
  });

  test("Photos: without provider keys the panel explains how to enable them", async () => {
    await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Photos",
      }),
    );
    expect(await screen.findByText(/stock photos are/)).toBeTruthy();
    expect(screen.getByText("UNSPLASH_ACCESS_KEY")).toBeTruthy();
  });

  test("Photos: a search result is copied into the library and placed with its attribution", async () => {
    const photo = {
      id: "unsplash:abc",
      provider: "unsplash",
      description: "golden hour",
      width: 3000,
      height: 2000,
      thumbUrl: "https://images.unsplash.com/abc-small",
      url: "https://images.unsplash.com/abc",
      author: "Ada",
      authorUrl: "https://unsplash.com/@ada",
      sourceUrl: "https://unsplash.com/photos/abc",
      license: "Unsplash License",
      downloadLocation: "https://api.unsplash.com/photos/abc/download",
    };
    const { editor, convex } = await mount(baseDesign(), {
      "stock/photos:search": () => ({ photos: [photo], hasMore: false }),
      "panels/stock:use": () => ({
        asset: {
          id: "asset9",
          refId: "stock0000001",
          kind: "image",
          name: "golden hour abc",
          mime: "image/jpeg",
          bytes: 100,
          width: 3000,
          height: 2000,
          durationMs: null,
          hash: "h",
          storageKey: "uploads/ws1/stock0000001/golden.jpg",
          source: "stock",
          family: null,
          weight: null,
          style: null,
          url: "https://example.invalid/golden.jpg",
        },
      }),
    });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Photos",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Add photo by Ada/ }));
    await waitFor(() => expect(nodesOf(editor.design).some((n) => n.type === "image")).toBe(true));
    const ref = editor.design?.assets.stock0000001;
    expect(ref).toMatchObject({
      source: "stock",
      attribution: { author: "Ada", license: "Unsplash License" },
    });
    const use = convex.calls.find((c) => c.name === "panels/stock:use");
    expect(use?.args).toMatchObject({
      workspaceId: "ws1",
      photo: { id: "unsplash:abc", downloadLocation: photo.downloadLocation },
    });
  });

  test("Brand: apply the kit to the page", async () => {
    const { editor } = await mount();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Brand",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "This page" }));
    await waitFor(() => expect(editor.design?.brandKitId).toBe("kit1"));
    const bg = (pageOf(editor).background[0] as { color: string }).color;
    expect(bg).toBe("#faf8f4");
  });

  test("Inspector: a pixel line height shows as a percentage of the font size", async () => {
    let d = baseDesign();
    const page = pageIdOf(d);
    const text = createText({
      parent: page,
      text: "Imported",
      style: defaultTextStyle({ fontSize: 40 }),
      paragraph: defaultParagraph({ lineHeight: { unit: "px", value: 48 } }),
    });
    d = withNodes(d, page, [text]);
    const { editor } = await mount(d);
    act(() => editor.select([text.id]));
    const lh = (await screen.findByRole("spinbutton", { name: "Line height" })) as HTMLInputElement;
    expect(lh.value).toBe("120");
  });

  test("Brand: a custom brand font is added to the design with the restyle", async () => {
    let d = baseDesign();
    const page = pageIdOf(d);
    const text = createText({ parent: page, text: "Big news", role: "headline" });
    d = withNodes(d, page, [text]);
    const { editor } = await mount(d, {
      "brand/brandKits:list": () => [
        {
          id: "kit2",
          workspaceId: "ws1",
          name: "Grotesk Co",
          logos: [],
          colors: [],
          fonts: {
            heading: {
              family: "Sun Grotesk",
              weight: 700,
              style: "normal",
              assetId: "asset_font_1",
              url: "https://example.invalid/font.woff2",
              refId: "brandfont001",
            },
          },
          voice: null,
          rules: [],
          isDefault: true,
        },
      ],
      "assets/assets:get": () => ({
        id: "asset_font_1",
        refId: "brandfont001",
        kind: "font",
        name: "Sun Grotesk.woff2",
        mime: "font/woff2",
        bytes: 20_000,
        width: null,
        height: null,
        durationMs: null,
        hash: "abc",
        storageKey: "uploads/ws1/brandfont001/Sun Grotesk.woff2",
        source: "upload",
        family: "Sun Grotesk",
        weight: 700,
        style: "normal",
        url: "https://example.invalid/font.woff2",
      }),
    });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", {
        name: "Brand",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "This page" }));
    await waitFor(() =>
      expect((editor.design?.nodes[text.id] as TextNode | undefined)?.style.fontFamily).toBe(
        "Sun Grotesk",
      ),
    );
    expect(editor.design?.assets.brandfont001).toMatchObject({
      kind: "font",
      family: "Sun Grotesk",
      source: "brand",
    });
    expect(editor.design?.assets.brandfont001?.url).toBeUndefined();
    // One step for the whole restyle.
    expect(editor.getState().history.undoLabel).toBe("Apply brand to page");
  });

  test("Effects and Animate tabs edit the selection", async () => {
    const { editor } = await mount();
    const rect = nodesOf(editor.design).find((n) => n.type === "rect") as Node;
    act(() => editor.select([rect.id]));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Effects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Soft" }));
    await waitFor(() => expect(editor.design?.nodes[rect.id]?.effects[0]?.type).toBe("dropShadow"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Animate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rise" }));
    await waitFor(() =>
      expect(editor.design?.nodes[rect.id]?.anim?.[0]).toMatchObject({
        preset: "rise",
        phase: "in",
      }),
    );
  });
});
