import {
  createDesign,
  createImage,
  createRect,
  createText,
  type Design,
  defaultTextStyle,
  type ImageNode,
} from "@desyn/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { EditorProvider } from "../../src/context.tsx";
import type { EditorController } from "../../src/controller.ts";
import { refs, usePaginatedBackendQuery } from "../../src/panels/backend.ts";
import {
  coverRegion,
  cropFocus,
  cropZoom,
  focusCropPatch,
  visibleRegion,
  zoomCropPatch,
} from "../../src/panels/lib/image-crop.ts";
import { liveEdit } from "../../src/panels/lib/live.ts";
import { updateEach } from "../../src/panels/lib/ops.ts";
import { brandFontAssets } from "../../src/panels/rail/brand-panel.tsx";
import { createTestEditor, node, pageIdOf, withNodes } from "../editor-helpers.ts";
import { FakeEngine, fakeEngineFactory } from "../fake-engine.ts";
import { settle, until } from "../fake-server.ts";
import { FakeConvex, page } from "./fake-convex.ts";

// Regression tests for the panels review: gestures that end where they started, crop zoom in the
// renderer's model, and custom brand fonts carried into the design.

describe("inspector gestures", () => {
  async function withEngine() {
    let design = createDesign("social-post");
    const page = pageIdOf(design);
    const rect = createRect({ parent: page, name: "Card", width: 100, height: 100 });
    design = withNodes(design, page, [rect]);
    const engine = new FakeEngine();
    const t = await createTestEditor(design, {
      engine: { createClient: fakeEngineFactory(engine) },
    });
    await t.editor.engine.attach(document.createElement("canvas"), () => t.editor.design);
    return { ...t, engine, id: rect.id };
  }

  test("a scrub that ends on its starting value commits nothing (not its last step)", async () => {
    const { editor, server, engine, id } = await withEngine();
    const seq = server.seq;
    const edit = liveEdit(editor, "Opacity");
    for (const v of [0.8, 0.5, 0.3]) {
      edit.preview((d) => updateEach(d, [id], () => ({ opacity: v })));
      await until(() => engine.previewing !== null);
    }
    edit.commit((d) => updateEach(d, [id], () => ({ opacity: 1 })));
    await settle();
    expect(node(editor, id).opacity).toBe(1);
    expect(engine.previewing).toBeNull();
    expect(editor.history.undoDepth).toBe(0);
    expect(server.seq).toBe(seq);
  });

  test("a scrub commits its final value as one undo step", async () => {
    const { editor, engine, id } = await withEngine();
    const edit = liveEdit(editor, "Opacity");
    for (const v of [0.8, 0.5]) {
      edit.preview((d) => updateEach(d, [id], () => ({ opacity: v })));
      await until(() => engine.previewing !== null);
    }
    edit.commit((d) => updateEach(d, [id], () => ({ opacity: 0.4 })));
    await until(() => node(editor, id).opacity === 0.4);
    expect(editor.history.undoDepth).toBe(1);
    await editor.undo();
    expect(node(editor, id).opacity).toBe(1);
  });
});

describe("image crop zoom (renderer model)", () => {
  function image(over: Partial<ImageNode> = {}): ImageNode {
    return {
      ...createImage({ parent: "page00000001", assetId: "img000000001", width: 400, height: 400 }),
      ...over,
    } as ImageNode;
  }

  /** What crates/desyn-raster shows for a crop (display/image.rs `Fit::Crop`), as a source region. */
  function rendered(n: ImageNode, sw: number, sh: number) {
    return visibleRegion(n, sw, sh);
  }

  test("zoom 2 on a landscape photo in a square box shows half of the cover region", () => {
    const n = image();
    const base = coverRegion(n, 1600, 800);
    expect(base).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    const patch = zoomCropPatch(n, 1600, 800, 2);
    expect(patch.crop).toEqual({ x: 0.375, y: 0.25, w: 0.25, h: 0.5 });
    // No `zoom` key: the renderer would multiply it on top of the rect (zooming twice).
    expect("zoom" in patch.crop).toBe(false);
    const zoomed = { ...n, ...patch } as ImageNode;
    expect(rendered(zoomed, 1600, 800)).toEqual(patch.crop);
    expect(cropZoom(zoomed, 1600, 800)).toBeCloseTo(2, 6);
  });

  test("a legacy crop with a zoom factor reads back at its true zoom and loses the factor", () => {
    const n = image({ fit: "crop", crop: { x: 0, y: 0, w: 1, h: 1, zoom: 2 } });
    // Square source in a square box: the renderer shows the middle half.
    expect(rendered(n, 800, 800)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(cropZoom(n, 800, 800)).toBeCloseTo(2, 6);
    const patch = zoomCropPatch(n, 800, 800, 4);
    expect(patch.crop).toEqual({ x: 0.375, y: 0.375, w: 0.25, h: 0.25 });
  });

  test("focus moves within the free range and is clamped", () => {
    const n = { ...image(), ...zoomCropPatch(image(), 800, 800, 2) } as ImageNode;
    expect(cropFocus(n, 800, 800)).toEqual({ x: 0.5, y: 0.5 });
    const left = { ...n, ...focusCropPatch(n, 800, 800, "x", 0) } as ImageNode;
    expect(left.crop?.x).toBe(0);
    expect(cropFocus(left, 800, 800).x).toBe(0);
    const right = { ...n, ...focusCropPatch(n, 800, 800, "x", 7) } as ImageNode;
    expect(right.crop?.x).toBe(0.5);
    // Zooming out past the edges keeps the region inside the source.
    const out = zoomCropPatch(right, 800, 800, 1);
    expect(out.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("brand fonts", () => {
  function editorWith(design: Design, convex: FakeConvex | null) {
    const primed: string[] = [];
    const editor = {
      convex: convex?.asClient() ?? null,
      design,
      assets: { prime: (id: string) => primed.push(id) },
    } as unknown as EditorController;
    return { editor, primed };
  }

  const fontView = {
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
    url: "https://s3.test/signed",
  };

  test("custom brand fonts become font assets of the design; catalog fonts need none", async () => {
    const convex = new FakeConvex({ "assets/assets:get": () => fontView });
    let design = createDesign("social-post");
    const page = pageIdOf(design);
    design = withNodes(design, page, [
      createText({ parent: page, text: "Hi", style: defaultTextStyle({ fontFamily: "Inter" }) }),
    ]);
    const { editor, primed } = editorWith(design, convex);
    const refs = await brandFontAssets(editor, [
      { family: "Inter", weight: 400, style: "normal", url: null, refId: null },
      {
        family: "Sun Grotesk",
        weight: 700,
        style: "normal",
        assetId: "asset_font_1",
        url: null,
        refId: "brandfont001",
      },
      undefined,
    ]);
    expect(refs).toEqual([
      expect.objectContaining({
        id: "brandfont001",
        kind: "font",
        family: "Sun Grotesk",
        weight: 700,
        source: "brand",
      }),
    ]);
    expect(primed).toEqual(["brandfont001"]);
    expect(convex.calls.map((c) => c.name)).toEqual(["assets/assets:get"]);

    // Already in the design: nothing to fetch.
    const withFont = {
      ...design,
      assets: { brandfont001: refs[0] as NonNullable<(typeof refs)[0]> },
    };
    const again = editorWith(withFont, convex);
    expect(
      await brandFontAssets(again.editor, [
        {
          family: "Sun Grotesk",
          weight: 700,
          style: "normal",
          assetId: "asset_font_1",
          url: null,
          refId: "brandfont001",
        },
      ]),
    ).toEqual([]);
    expect(convex.calls).toHaveLength(1);
  });
});

describe("paginated backend queries", () => {
  test("new arguments start from the first page; old cursors are never sent with them", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      category: i % 2 ? "a" : "b",
    }));
    const convex = new FakeConvex({
      "templates/templates:list": (args) =>
        page(
          items.filter((t) => !args.category || t.category === args.category),
          args,
        ),
    });
    const editor = { convex: convex.asClient() } as unknown as EditorController;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EditorProvider editor={editor}>{children}</EditorProvider>
    );
    const { result, rerender } = renderHook(
      ({ category }: { category?: string }) =>
        usePaginatedBackendQuery(refs.templatesList, category ? { category } : {}, 10),
      { wrapper, initialProps: {} as { category?: string } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(10));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(20));
    rerender({ category: "a" });
    await waitFor(() => expect(result.current.items).toHaveLength(10));
    expect(result.current.items.every((t) => (t as { category: string }).category === "a")).toBe(
      true,
    );
    const filtered = convex.calls.filter(
      (c) => c.name === "templates/templates:list" && c.args.category === "a",
    );
    expect(filtered.length).toBeGreaterThan(0);
    for (const c of filtered) {
      expect((c.args.paginationOpts as { cursor: string | null }).cursor).toBeNull();
    }
  });
});
