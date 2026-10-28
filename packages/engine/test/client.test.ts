// EngineClient + EngineHost end to end in Node (main-thread mode over the in-process RPC channel): loading,
// mirror updates, previews, presenting to the canvas (full frames, damage, whole-pixel scrolls), assets,
// fonts, exports through the exporters module, text geometry, and the WasmHost DocHost.
import type { Transaction } from "@desyn/schema";
import { canonicalEqual } from "@desyn/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineClient } from "../src/client";
import { WasmHost } from "../src/wasm-host";
import {
  FakeCanvas,
  fixture,
  fixtureAsset,
  installCanvasGlobals,
  installFileFetch,
} from "./helpers";

installFileFetch();
installCanvasGlobals();

let client: EngineClient;
let canvas: FakeCanvas;

beforeAll(async () => {
  canvas = new FakeCanvas(400, 300);
  client = await EngineClient.create({
    canvas: canvas as unknown as HTMLCanvasElement,
    mode: "main",
    autoResize: false,
    // Offline: bundled fonts only.
    fonts: { googleFonts: false },
    render: { background: "#0e0e0e", pageShadow: false, budgetMs: undefined },
    resolveAsset: (a) => fixtureAsset(a.id === "photo0000001" ? "photo0000001.jpg" : `${a.id}.png`),
  });
});

afterAll(() => client.dispose());

function tx(id: string, ops: Transaction["ops"]): Transaction {
  return { id, label: "Test", ops, source: "user", ts: 0 };
}

describe("EngineClient (main-thread mode)", () => {
  it("starts on the main thread when asked", () => {
    expect(client.mode).toBe("main");
    expect(client.info.formats).toContain("png");
  });

  it("loads a design, waits for its fonts and presents the first frame", async () => {
    const info = await client.load(fixture("shapes"));
    expect(info.pages[0]?.id).toBe("shapespa0030");
    client.setView({ x: 0, y: 0, zoom: 0.5, width: 300, height: 300, dpr: 1 });
    const frame = await client.flush();
    expect(frame?.pending).toBe(0);
    expect(canvas.width).toBe(300);
    // Pixels on the canvas are the engine's frame: the page background at the origin.
    expect(Array.from(canvas.pixels.subarray(0, 4))).toEqual([246, 244, 240, 255]);
  });

  it("applies transactions and keeps the mirror equal to the engine", async () => {
    // Clear the canvas log first: the damaged frame can be presented while `apply` or `snapshot` is still
    // awaiting (the host paces frames on its own timer), so clearing after them races that frame.
    canvas.log.length = 0;
    const r = await client.apply(
      tx("txclient0001", [{ op: "update", id: "rectplai0001", set: { x: 64 } }]),
    );
    expect(r.applied.length).toBe(1);
    expect(client.design.nodes.rectplai0001?.x).toBe(64);
    const engine = await client.snapshot();
    expect(canonicalEqual(engine, client.design)).toBe(true);
    await client.flush();
    // Only the damaged area is copied.
    const puts = canvas.log.filter((l) => l.startsWith("put"));
    expect(puts.length).toBeGreaterThan(0);
    const area = puts.reduce((s, l) => {
      const [, , w = "0", h = "0"] = l.slice(4).split(",");
      return s + Number(w) * Number(h);
    }, 0);
    expect(area).toBeLessThan(300 * 300);
  });

  it("previews coalesce, commit into the mirror, and cancel restores", async () => {
    const results = await Promise.all(
      [10, 20, 30, 40].map((x, i) =>
        client.preview(
          tx(`txprev${String(i).padStart(6, "0")}`, [
            { op: "update", id: "rectplai0001", set: { x } },
          ]),
        ),
      ),
    );
    // The first is sent, the middle ones are superseded, the last one is sent after the first returns.
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
    expect(results[3]).not.toBeNull();
    expect(client.design.nodes.rectplai0001?.x).toBe(64);
    const committed = await client.commitPreview({ label: "Drag" });
    expect(committed?.design.nodes.rectplai0001?.x).toBe(40);
    await client.preview(tx("txprev999999", [{ op: "update", id: "rectplai0001", set: { x: 5 } }]));
    expect(await client.cancelPreview()).toBe(true);
    const engine = await client.snapshot();
    expect(engine.nodes.rectplai0001?.x).toBe(40);
  });

  it("scrolls by whole device pixels and presents the same pixels as a fresh render", async () => {
    await client.flush();
    canvas.log.length = 0;
    client.setView({ x: client.view.x - 20, y: client.view.y + 10 });
    await client.flush();
    expect(canvas.log[0]).toBe("scroll 10,-5");
    const shifted = canvas.pixels.slice();
    // A forced full redraw of the same view must give the same image.
    client.setRenderOptions({ background: "#0e0e0f" });
    await client.flush();
    client.setRenderOptions({ background: "#0e0e0e" });
    await client.flush();
    let diff = 0;
    for (let i = 0; i < shifted.length; i++)
      if (Math.abs((shifted[i] ?? 0) - (canvas.pixels[i] ?? 0)) > 2) diff++;
    expect(diff / shifted.length).toBeLessThan(0.001);
  });

  it("hit tests in screen space", async () => {
    client.setView({ x: 0, y: 0, zoom: 1 });
    const hit = await client.hitTestScreen({ x: 40 + 10, y: 20 + 10 });
    expect(hit.id).toBe("rectplai0001");
    const handles = await client.handles({ ids: ["rectplai0001"] });
    expect(handles.handles?.resize).toHaveLength(8);
  });

  it("resolves missing assets, reports decode failures and exports with the exporters module", async () => {
    const errors: string[] = [];
    const off = client.on("assetError", (e) => errors.push(e.id));
    await client.load(fixture("images"));
    client.setView({ x: 0, y: 0, zoom: 0.5, width: 300, height: 300 });
    await client.flush();
    await client.ensureAssets();
    // cutout and matte resolve to files; the photo is a JPEG.
    expect(errors).toEqual([]);
    const pdf = await client.export({ format: "pdf" });
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(pdf.info.missingAssets).toEqual([]);
    const png = await client.export({ format: "png", scale: 0.25 });
    expect(png.info.mime).toBe("image/png");
    off();
  });

  it("gives text geometry for the editing overlay", async () => {
    await client.load(fixture("text"));
    const layout = await client.textLayout("headline0001");
    expect(layout.lines.length).toBeGreaterThan(0);
    const sel = await client.textQuery({
      op: "selection",
      nodeId: "headline0001",
      start: 0,
      end: 4,
    });
    expect(sel.quads.length).toBeGreaterThan(0);
    const outline = await client.outlineText("headline0001");
    expect(outline.d.startsWith("M")).toBe(true);
  });
});

describe("WasmHost (DocHost for the AI agent)", () => {
  it("describes, renders, measures and applies through the engine", async () => {
    await client.load(fixture("social"));
    const applied: string[] = [];
    const host = new WasmHost(client, {
      upload: async () => {
        throw new Error("no uploads in this test");
      },
      selection: () => [],
      onApply: (t) => {
        applied.push(t.id);
      },
    });
    const d = await host.describe();
    expect(d.design.pageCount).toBe(1);
    expect(d.tree.length).toBeGreaterThan(0);
    const shot = await host.render({ maxSize: 256 });
    expect(shot.mime).toBe("image/png");
    expect(Math.max(shot.width, shot.height)).toBe(256);
    const [m] = await host.measure([
      {
        text: [{ text: "Measure me" }],
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontStyle: "normal",
          fontSize: 20,
          fills: [],
          letterSpacing: 0,
          textCase: "none",
          decoration: "none",
        },
        paragraph: {
          align: "left",
          direction: "ltr",
          lineHeight: { unit: "auto", value: 0 },
          spacing: 0,
          indent: 0,
          list: "none",
        },
      },
    ]);
    expect(m?.lines).toBe(1);
    expect(m?.w).toBeGreaterThan(50);
    const first = Object.values(host.getDesign().nodes).find((n) => n.type === "rect");
    expect(first).toBeDefined();
    if (!first) return;
    const r = await host.apply(
      tx("txaihost0001", [{ op: "update", id: first.id, set: { opacity: 0.5 } }]),
    );
    expect(r.design.nodes[first.id]?.opacity).toBe(0.5);
    expect(applied).toEqual(["txaihost0001"]);
    expect(host.getDesign().nodes[first.id]?.opacity).toBe(0.5);
  });
});

describe("WasmHost uploads", () => {
  it("registers uploaded SVG bytes once a transaction references them (no decode as a raster image)", async () => {
    await client.load(fixture("social"));
    const errors: string[] = [];
    const off = client.on("assetError", (e) => errors.push(`${e.id}: ${e.message}`));
    const ref = {
      id: "aisvgupl0001",
      kind: "svg" as const,
      mime: "image/svg+xml",
      width: 64,
      height: 64,
    };
    const svg = fixtureAsset("icon00000001.svg");
    const host = new WasmHost(client, { upload: async () => ref });
    const uploaded = await host.assets.upload(svg, "image/svg+xml", { kind: "svg" });
    expect(uploaded.id).toBe(ref.id);
    // Readable before the design references it (tools read what they just uploaded).
    expect((await host.assets.read(ref.id)).bytes.length).toBe(svg.length);
    await host.apply(tx("txaiupload01", [{ op: "asset", set: { [ref.id]: ref } }]));
    // The engine got the bytes (no URL to fetch them from) and decoded them as SVG.
    const back = await client.readAsset(ref.id);
    expect(back.bytes.length).toBe(svg.length);
    expect(errors).toEqual([]);
    off();
  });

  it("reports the real preview size", async () => {
    const host = new WasmHost(client, { upload: async () => Promise.reject(new Error("unused")) });
    const shot = await host.render({ scale: 0.37 });
    const page = client.pages[0];
    expect(page).toBeDefined();
    if (!page) return;
    expect(shot.width).toBe(Math.round(page.width * 0.37));
    // The PNG header and the reported size agree.
    const view = new DataView(shot.bytes.buffer, shot.bytes.byteOffset);
    expect(view.getUint32(16)).toBe(shot.width);
    expect(view.getUint32(20)).toBe(shot.height);
  });
});
