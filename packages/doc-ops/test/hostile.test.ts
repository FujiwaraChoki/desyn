// Hostile transactions: random mixes of malformed, ill-typed and adversarial ops (wrong types, bad paths,
// "__proto__" keys, numeric discriminants, out-of-range indices). applyTransaction must never throw, must keep
// the design valid, and its inverse / applied lists must replay exactly. The same generator was used to
// cross-check the Rust core op for op during review.
import {
  canonicalize,
  createFrame,
  createGroup,
  createPage,
  createRect,
  createText,
  validateDesign,
} from "@desyn/schema";
import { expect, test } from "vitest";
import { applyOps, applyTransaction } from "../src";
import { int, pick, randomDesign, rng } from "./helpers";

test("hostile op lists never throw and keep every invariant", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const d = randomDesign(seed);
    const r = rng(seed * 31);
    const ids = [
      ...Object.keys(d.nodes),
      "missing00001",
      "root",
      42,
      null,
      "",
      "__proto__",
      "constructor",
    ];
    const anyVal = () =>
      pick(r, [
        null,
        1,
        -0.5,
        1.5,
        1e21,
        "x",
        "#ABCDEF",
        "#abcdef",
        true,
        [],
        {},
        [1, "a"],
        { type: "solid", color: "#000000" },
        { $var: "brand.primary" },
        JSON.parse('{"__proto__":{"a":1}}'),
        undefined,
      ]);
    const anyPath = () =>
      pick(r, [
        [],
        ["name"],
        ["x"],
        ["fills"],
        ["fills", 0],
        ["fills", 0, "color"],
        ["fills", -1],
        ["fills", 1.5],
        ["fills", "0"],
        ["children", 0],
        ["type"],
        ["id"],
        ["parent"],
        ["meta"],
        ["meta", "k"],
        ["style", "fills", 0, "color"],
        ["runs", 0, "text"],
        ["effects", 0],
        ["layout", "gap"],
        ["__proto__"],
        ["constructor", "prototype"],
        [null],
        "name",
        ["cornerRadius", 2],
        ["paragraph", "lineHeight", "value"],
      ]);
    const ops: unknown[] = [];
    const n = int(r, 1, 25);
    for (let i = 0; i < n; i++) {
      const id = pick(r, ids);
      const nid = `h${String(seed).padStart(5, "0")}${String(i).padStart(6, "0")}`;
      switch (int(r, 0, 9)) {
        case 0: {
          const parent = pick(r, ids);
          const t = int(r, 0, 4);
          const node = (t === 0
            ? createPage({ id: nid })
            : t === 1
              ? createFrame({ id: nid, parent: String(parent) })
              : t === 2
                ? createText({ id: nid })
                : t === 3
                  ? createGroup({ id: nid })
                  : createRect({ id: nid })) as unknown as Record<string, unknown>;
          if (r() < 0.2)
            node[pick(r, ["opacity", "x", "children", "type", "fills", "id"])] = anyVal();
          const op: Record<string, unknown> = {
            op: "create",
            nodes: r() < 0.1 ? [] : [node],
            parent,
          };
          if (r() < 0.6) op.index = pick(r, [0, 1, -3, 99, 1.5, "1", null]);
          ops.push(op);
          ids.push(nid);
          break;
        }
        case 1: {
          const set: Record<string, unknown> = {};
          for (let k = 0; k < int(r, 0, 3); k++)
            set[
              pick(r, [
                "name",
                "x",
                "opacity",
                "fills",
                "role",
                "alt",
                "futureKey",
                "children",
                "id",
                "width",
                "locked",
              ])
            ] = anyVal();
          const op: Record<string, unknown> = { op: "update", id };
          if (r() < 0.8) op.set = r() < 0.1 ? [] : set;
          if (r() < 0.4)
            op.unset = pick(r, [
              ["alt"],
              ["name"],
              ["role", "role"],
              ["x"],
              [1],
              "alt",
              ["futureKey"],
              [],
            ]);
          ops.push(op);
          break;
        }
        case 2: {
          const op: Record<string, unknown> = { op: "patch", id, path: anyPath() };
          if (r() < 0.9) op.value = anyVal();
          ops.push(op);
          break;
        }
        case 3:
          ops.push(r() < 0.9 ? { op: "delete", id } : { op: "delete" });
          break;
        case 4: {
          const op: Record<string, unknown> = { op: "move", id, parent: pick(r, ids) };
          if (r() < 0.7) op.index = pick(r, [0, 1, 2, -1, 50, 0.5, null]);
          ops.push(op);
          break;
        }
        case 5: {
          const aid = pick(r, ["asset0000001", "as0000000001", "BAD", "as0000000002"]);
          const rec: Record<string, unknown> = {
            id: r() < 0.9 ? aid : "other0000001",
            kind: pick(r, ["image", "svg", "zip"]),
            mime: "image/png",
          };
          const op: Record<string, unknown> = { op: "asset" };
          if (r() < 0.7) op.set = { [aid]: rec };
          if (r() < 0.5)
            op.remove = pick(r, [
              ["asset0000001"],
              ["as0000000001", "as0000000001"],
              [aid],
              "x",
              [1],
            ]);
          ops.push(op);
          break;
        }
        case 6: {
          const op: Record<string, unknown> = {
            op: "styles",
            path: pick(r, [
              [],
              ["variables"],
              ["variables", "k"],
              ["colors", "color0000001", "value"],
              ["colors", "color0000001"],
              ["colors", "abc"],
              ["text"],
              ["nope", "x"],
              ["variables", 0],
              "x",
            ]),
          };
          if (r() < 0.9)
            op.value = pick(r, [
              anyVal(),
              { colors: {}, text: {}, effects: {}, variables: {} },
              { name: "C", value: "#112233" },
              "#112233",
            ]);
          ops.push(op);
          break;
        }
        case 7: {
          const set: Record<string, unknown> = {};
          for (let k = 0; k < int(r, 0, 2); k++)
            set[pick(r, ["name", "kind", "brandKitId", "meta", "id"])] = pick(r, [
              anyVal(),
              "poster",
              "kit_1",
              { tags: ["a"] },
            ]);
          const op: Record<string, unknown> = { op: "doc" };
          if (r() < 0.9) op.set = set;
          if (r() < 0.4)
            op.unset = pick(r, [
              ["brandKitId"],
              [],
              ["brandKitId", "brandKitId"],
              ["name"],
              "brandKitId",
            ]);
          ops.push(op);
          break;
        }
        case 8:
          ops.push(pick(r, [null, 1, "op", [], { op: "nope" }, {}]));
          break;
        default:
          ops.push({ op: "update", id, set: { x: int(r, 0, 100) } });
      }
    }
    const tx = JSON.parse(
      JSON.stringify({ id: "host00000001", label: "hostile", ops, source: "user", ts: 1 }),
    );
    const before = canonicalize(d);
    const res = applyTransaction(d, tx);
    expect(canonicalize(d)).toBe(before);
    const v = validateDesign(res.design);
    expect(v.errors, `seed ${seed}`).toEqual([]);
    expect(res.applied.length + res.dropped.length).toBe(tx.ops.length);
    const undo = applyTransaction(res.design, res.inverse);
    expect(undo.dropped, `seed ${seed}`).toEqual([]);
    expect(canonicalize(undo.design), `seed ${seed}`).toBe(before);
    const replay = applyOps(d, res.applied);
    expect(replay.dropped).toEqual([]);
    expect(canonicalize(replay.design)).toBe(canonicalize(res.design));
  }
}, 120000);
