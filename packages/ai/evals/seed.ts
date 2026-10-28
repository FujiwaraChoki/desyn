// Starting designs for eval cases: a blank page for generate cases, a small real social post for edit cases.
import { applyTransaction, pages } from "@desyn/doc-ops";
import {
  createDesign,
  createRect,
  createText,
  type Design,
  defaultTextStyle,
  newId,
  type Op,
} from "@desyn/schema";
import type { GoldenCase } from "./golden";

/** A 1080×1080 post: background, headline, body and a CTA, all with roles. */
function editSeed(golden: GoldenCase): Design {
  const base = createDesign(golden.kind, golden.preset, { name: "Spring sale" });
  const page = pages(base)[0];
  if (!page) throw new Error("seed design has no page");
  const nodes = [
    createRect({
      id: newId(),
      name: "Background",
      role: "background",
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
      fills: [{ type: "solid", color: "#f5efe6" }],
    }),
    createText({
      id: newId(),
      name: "Headline",
      role: "headline",
      text: "Spring collection is here",
      x: 80,
      y: 360,
      width: page.width - 160,
      height: 77,
      style: defaultTextStyle({
        fontFamily: "Inter",
        fontSize: 64,
        fontWeight: 500,
        fills: [{ type: "solid", color: "#1a1a1a" }],
      }),
    }),
    createText({
      id: newId(),
      name: "Body",
      role: "body",
      text: "Fresh styles, light fabrics and 20% off for the first week.",
      x: 80,
      y: 470,
      width: page.width - 160,
      height: 72,
      style: defaultTextStyle({
        fontFamily: "Inter",
        fontSize: 30,
        fills: [{ type: "solid", color: "#333333" }],
      }),
    }),
  ];
  const ops: Op[] = nodes.map((n) => ({ op: "create", nodes: [n], parent: page.id }));
  return applyTransaction(base, { id: newId(), label: "seed", ops, source: "system", ts: 0 })
    .design;
}

export function seedDesign(golden: GoldenCase): Design {
  return golden.mode === "edit"
    ? editSeed(golden)
    : createDesign(golden.kind, golden.preset, { name: golden.id });
}
