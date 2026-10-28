// The wasm engine itself, in Node: JSON surface, frame buffer views, and the contract that the client mirror
// (doc-ops replaying the engine's `applied` ops) stays canonically equal to the engine's own state.
import { readFileSync } from "node:fs";
import { applyTransaction } from "@desyn/doc-ops";
import { canonicalEqual, type Design, type Transaction } from "@desyn/schema";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  EngineApplyResult,
  FrameInfo,
  HitResult,
  TextLayoutInfo,
  TextQueryResult,
} from "../src/protocol";
import { type EngineModule, loadEngineModule, loadExportModule } from "../src/wasm";
import { fixture, fixtureAsset } from "./helpers";

const wasm = (name: string) => readFileSync(new URL(`../wasm/${name}_bg.wasm`, import.meta.url));
const font = (file: string) =>
  new Uint8Array(readFileSync(new URL(`../fonts/${file}`, import.meta.url)));

let mod: EngineModule;

beforeAll(async () => {
  mod = await loadEngineModule(wasm("desyn_engine"));
});

function newEngine(design: Design) {
  const e = mod.create(new Uint8Array(32).fill(3));
  e.setFont(font("Inter-VF.ttf"), "Inter");
  e.setFont(font("InstrumentSerif-Regular.ttf"), "Instrument Serif");
  e.setFont(font("InstrumentSerif-Italic.ttf"), "Instrument Serif");
  e.setFont(font("JetBrainsMono-VF.ttf"), "JetBrains Mono");
  e.load(JSON.stringify(design));
  return e;
}

function tx(id: string, ops: Transaction["ops"]): Transaction {
  return { id, label: "Test", ops, source: "user", ts: 0 };
}

describe("wasm engine", () => {
  it("reports build info", () => {
    expect(mod.info.formats).toEqual(expect.arrayContaining(["png", "svg"]));
    expect(mod.info.exporters).toBe(false);
  });

  it("renders into a frame buffer the host reads in place", () => {
    const e = newEngine(fixture("shapes"));
    const info = JSON.parse(
      e.render(
        JSON.stringify({
          viewport: { x: 0, y: 0, zoom: 0.5, width: 240, height: 260, dpr: 1 },
          background: "#0e0e0e",
        }),
      ),
    ) as FrameInfo;
    expect(info.rects).toEqual([[0, 0, 240, 260]]);
    expect(e.frameLen()).toBe(240 * 260 * 4);
    const view = new Uint8Array(mod.memory.buffer, e.framePtr(), e.frameLen());
    // The page's background color at its top-left corner.
    const page = fixture("shapes").nodes.shapespa0030;
    const bg =
      page?.type === "page" && page.background[0]?.type === "solid"
        ? String(page.background[0].color)
        : "";
    const hex = [1, 3, 5].map((i) => Number.parseInt(bg.slice(i, i + 2), 16));
    expect(Array.from(view.subarray(0, 4))).toEqual([...hex, 255]);
    e.free();
  });

  it("keeps the doc-ops mirror canonically equal to the engine across normalized edits", () => {
    for (const name of ["shapes", "text", "social"]) {
      const design = fixture(name);
      const e = newEngine(design);
      let mirror = design;
      const ids = Object.keys(design.nodes).filter((id) => {
        const n = design.nodes[id];
        return n && n.type !== "root" && n.type !== "page";
      });
      const txs: Transaction[] = [];
      for (const [i, id] of ids.slice(0, 6).entries()) {
        const n = design.nodes[id];
        if (!n) continue;
        txs.push(
          tx(`tx${String(i).padStart(10, "0")}`, [
            { op: "update", id, set: { x: n.x + 7, width: n.width + 13 } },
          ]),
        );
      }
      const textId = ids.find((id) => design.nodes[id]?.type === "text");
      if (textId) {
        txs.push(
          tx("txtext000001", [
            {
              op: "update",
              id: textId,
              set: { runs: [{ text: "A much longer headline that wraps onto several lines now" }] },
            },
          ]),
        );
      }
      for (const t of txs) {
        const r = JSON.parse(e.applyTransaction(JSON.stringify(t), true)) as EngineApplyResult;
        mirror = applyTransaction(
          mirror,
          { ...t, ops: r.applied },
          { validateNodes: false },
        ).design;
      }
      const engineState = JSON.parse(e.snapshot()) as Design;
      expect(canonicalEqual(engineState, mirror)).toBe(true);
      e.free();
    }
  });

  it("previews, commits and undoes", () => {
    const design = fixture("shapes");
    const e = newEngine(design);
    const move = tx("txmove000001", [
      { op: "update", id: "rectplai0001", set: { x: 300, y: 300 } },
    ]);
    const preview = JSON.parse(e.preview(JSON.stringify(move), true)) as EngineApplyResult;
    expect(preview.applied.length).toBeGreaterThan(0);
    const committed = JSON.parse(e.commitPreview()) as EngineApplyResult;
    expect(committed.inverse.ops.length).toBeGreaterThan(0);
    e.applyTransaction(JSON.stringify(committed.inverse), false);
    expect(canonicalEqual(JSON.parse(e.snapshot()), design)).toBe(true);
    expect(e.commitPreview()).toBe("null");
    e.free();
  });

  it("hit tests and answers text queries in UTF-16", () => {
    const e = newEngine(fixture("text"));
    const layout = JSON.parse(e.textLayout("headline0001")) as TextLayoutInfo;
    expect(layout.length).toBe(layout.text.length);
    const [a, b, c, d, ex, f] = layout.transform;
    // Center of the first line in page coordinates.
    const line = layout.lines[0];
    expect(line).toBeDefined();
    if (!line) return;
    const lx = line.x + line.width / 2;
    const ly = line.top + line.height / 2;
    const px = a * lx + c * ly + ex;
    const py = b * lx + d * ly + f;
    const hit = JSON.parse(e.hitTest(JSON.stringify({ x: px, y: py }))) as HitResult;
    expect(hit.id).toBe("headline0001");
    const q = JSON.parse(
      e.textQuery(JSON.stringify({ op: "hit", nodeId: "headline0001", x: px, y: py })),
    ) as TextQueryResult;
    expect(q.index).toBeGreaterThan(0);
    expect(q.index).toBeLessThan(layout.length);
    expect(() => e.textQuery(JSON.stringify({ op: "caret", nodeId: "nope" }))).toThrow();
    e.free();
  });

  it("surfaces asset decode errors as exceptions", () => {
    const e = newEngine(fixture("images"));
    expect(() => e.setAsset("photo0000001", new Uint8Array([1, 2, 3]))).toThrow(/photo0000001/);
    const info = JSON.parse(e.setAsset("photo0000001", fixtureAsset("photo0000001.jpg")));
    expect(info).toMatchObject({ kind: "image" });
    expect(info.width).toBeGreaterThan(100);
    e.free();
  });

  it("exports PNG and SVG here and PDF / PPTX / GIF through the exporters module", async () => {
    const design = fixture("social");
    const e = newEngine(design);
    const png = e.export(JSON.stringify({ format: "png", scale: 0.2 }));
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(() => e.export(JSON.stringify({ format: "pdf" }))).toThrow(/exporters/);
    const ex = await loadExportModule(wasm("desyn_export"));
    expect(ex.info.exporters).toBe(true);
    const full = ex.create(new Uint8Array(32));
    full.setFont(font("Inter-VF.ttf"), "Inter");
    full.load(JSON.stringify(design));
    const pdf = full.export(JSON.stringify({ format: "pdf" }));
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    const pptx = full.export(JSON.stringify({ format: "pptx" }));
    expect(Array.from(pptx.subarray(0, 2))).toEqual([0x50, 0x4b]);
    expect(JSON.parse(full.exportInfo()).mime).toContain("presentation");
    full.free();
    e.free();
  });
});
