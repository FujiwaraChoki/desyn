import { describe, expect, it } from "vitest";
import { BLUEPRINT_ORDER, BLUEPRINTS, BUILD_ORDER } from "./blueprints";
import { applyEdit, createDesign, moveLayer, toggleVisibility } from "./edits";
import { blueprintForPrompt, EDIT_LABELS, editForInstruction, headlineFromPrompt } from "./prompt";
import { ARTBOARD, type EditId } from "./types";

describe("blueprints", () => {
  it.each(BLUEPRINT_ORDER)("%s has one layer per role, in build order, inside the page", (id) => {
    const bp = BLUEPRINTS[id];
    expect(bp.layers.map((l) => l.id)).toEqual([...BUILD_ORDER]);
    const roles = new Set(bp.layers.map((l) => l.role));
    expect(roles.size).toBe(bp.layers.length);
    for (const l of bp.layers) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.x + l.width).toBeLessThanOrEqual(ARTBOARD.width);
      expect(l.y + l.height).toBeLessThanOrEqual(ARTBOARD.height);
    }
  });
});

describe("prompt matching", () => {
  it("picks the blueprint by vocabulary", () => {
    expect(blueprintForPrompt("Launch poster for a ceramic coffee cup")).toBe("product");
    expect(blueprintForPrompt("instagram post for a jazz night at our bar")).toBe("night");
    expect(blueprintForPrompt("Sunrise yoga retreat in the mountains")).toBe("retreat");
  });

  it("falls back deterministically when nothing matches", () => {
    expect(blueprintForPrompt("zzz", 0)).toBe("product");
    expect(blueprintForPrompt("zzz", 1)).toBe("night");
    expect(blueprintForPrompt("zzz", 5)).toBe("retreat");
  });

  it("derives a short headline from the visitor's words", () => {
    expect(headlineFromPrompt("a poster for my bakery's grand opening")).toBe(
      "Bakery's grand opening.",
    );
    expect(headlineFromPrompt("Make an instagram post about summer sale, 30% off")).toBe(
      "Summer sale.",
    );
    expect(headlineFromPrompt("design a flyer for the harvest festival with live music")).toBe(
      "Harvest festival.",
    );
    expect(headlineFromPrompt("a poster")).toBeNull();
    expect(headlineFromPrompt("   ")).toBeNull();
    expect(
      headlineFromPrompt("poster for supercalifragilisticexpialidocious celebrations"),
    ).toBeNull();
  });

  it("maps instructions onto available edits only", () => {
    const all = Object.keys(EDIT_LABELS) as EditId[];
    expect(editForInstruction("make it feel more luxurious", all)).toBe("premium");
    expect(editForInstruction("move the product to the right", all)).toBe("move-right");
    expect(editForInstruction("headline should be bigger", all)).toBe("bigger-headline");
    expect(editForInstruction("can we try warmer colours", all)).toBe("sunset");
    expect(editForInstruction("translate this to French please", all)).toBe("french");
    expect(editForInstruction("add a unicorn", all)).toBeNull();
    expect(editForInstruction("move it right", ["premium"])).toBeNull();
  });
});

describe("edits", () => {
  const roleOf = (id: string) => BLUEPRINTS.product.layers.find((l) => l.id === id)?.role;

  it("uses the visitor's headline and shrinks long ones", () => {
    const d = createDesign("product", "poster for our harvest festival");
    const h = d.layers.find((l) => l.role === "headline");
    expect(h?.text).toBe("Harvest festival.");
    expect(d.customHeadline).toBe(true);
    const long = createDesign("product", "poster for the riverside lantern parade");
    expect(long.layers.find((l) => l.role === "headline")?.fontSize).toBeLessThan(138);
  });

  it("does not mutate the blueprint", () => {
    const before = JSON.stringify(BLUEPRINTS.product.layers);
    const d = createDesign("product", "poster for harvest festival");
    applyEdit(applyEdit(d, "premium").design, "sunset");
    expect(JSON.stringify(BLUEPRINTS.product.layers)).toBe(before);
  });

  it.each(BLUEPRINT_ORDER)(
    "every advertised edit on %s changes something and leaves untouched layers identical",
    (id) => {
      const d = createDesign(id);
      for (const edit of BLUEPRINTS[id].edits) {
        const r = applyEdit(d, edit);
        expect(r.touched.length, `${id}/${edit}`).toBeGreaterThan(0);
        for (const before of d.layers) {
          const after = r.design.layers.find((l) => l.id === before.id);
          if (!r.touched.includes(before.id)) expect(after).toBe(before);
          else expect(after).not.toEqual(before);
        }
      }
    },
  );

  it("premium restyles without moving anything", () => {
    const d = createDesign("product");
    const r = applyEdit(d, "premium");
    for (const l of r.design.layers) {
      const b = d.layers.find((x) => x.id === l.id);
      expect([l.x, l.y]).toEqual([b?.x, b?.y]);
    }
    expect(r.design.layers.find((l) => l.role === "headline")?.italic).toBe(true);
  });

  it("move-right shifts the image and rebalances type to the left", () => {
    const d = createDesign("product");
    const r = applyEdit(d, "move-right");
    const photo = r.design.layers.find((l) => l.role === "photo");
    const before = d.layers.find((l) => l.role === "photo");
    expect(photo?.x).toBeGreaterThan(before?.x ?? 0);
    expect(r.design.layers.find((l) => l.role === "headline")?.align).toBe("left");
    expect(r.touched.map(roleOf)).not.toContain("background");
  });

  it("move-right refuses for full-bleed images", () => {
    const r = applyEdit(createDesign("retreat"), "move-right");
    expect(r.touched).toEqual([]);
  });

  it("bigger headline keeps copy below it from colliding", () => {
    for (const id of BLUEPRINT_ORDER) {
      const r = applyEdit(createDesign(id), "bigger-headline");
      const h = r.design.layers.find((l) => l.role === "headline");
      const sub = r.design.layers.find((l) => l.role === "subhead");
      if (!h || !sub) throw new Error("missing layers");
      expect(sub.y, id).toBeGreaterThanOrEqual(h.y + h.height - 1);
    }
  });

  it("translation keeps a custom headline", () => {
    const d = createDesign("night", "poster for harvest festival");
    const r = applyEdit(d, "french");
    expect(r.design.layers.find((l) => l.role === "headline")?.text).toBe("Harvest festival.");
    expect(r.design.layers.find((l) => l.role === "cta")?.text).toBe("Billets");
  });

  it("moveLayer clamps to the page and never moves the background", () => {
    const d = createDesign("product");
    const moved = moveLayer(d, "photo", 99999, -99999);
    const p = moved.layers.find((l) => l.id === "photo");
    expect(p?.x).toBeLessThanOrEqual(ARTBOARD.width);
    expect(p?.y).toBeGreaterThan(-(p?.height ?? 0));
    expect(moveLayer(d, "bg", 100, 100).layers[0]).toBe(d.layers[0]);
  });

  it("toggleVisibility flips one layer", () => {
    const d = toggleVisibility(createDesign("product"), "cta");
    expect(d.layers.find((l) => l.id === "cta")?.visible).toBe(false);
    expect(d.layers.filter((l) => !l.visible)).toHaveLength(1);
  });
});
