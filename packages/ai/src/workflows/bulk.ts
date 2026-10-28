// bulk: CSV merge into template slots (`meta.slot` on layers). One design per row: text slots get the cell text
// (boxes re-measured, shrinking to fit fixed boxes), image slots get an image from a URL or existing asset id,
// color slots (`*color*` slot names or layers with role badge/cta) get a hex fill, QR slots get data.
import { descendants, pages } from "@desyn/doc-ops";
import {
  type Design,
  type Id,
  isColor,
  type Node,
  normalizeHex,
  type Op,
  type TextNode,
} from "@desyn/schema";
import { z } from "zod";
import { estimateCredits } from "../credits";
import { coverCrop } from "../design/crop";
import type { DocHost } from "../host";
import { defaultFetch } from "../util/async";
import { sniffMime } from "../util/bytes";
import { applyWorkflowOps } from "./common";
import { parseCsv } from "./csv";
import type { WorkflowDefinition, WorkflowEnv } from "./types";

const BulkInput = z.object({
  designId: z.string().describe("template design with slots"),
  csv: z.string().min(1).max(2_000_000),
  mapping: z.record(z.string(), z.string()).describe("CSV column -> slot name"),
  nameColumn: z.string().optional(),
  maxRows: z.number().int().min(1).max(1000).default(200),
  delimiter: z.string().length(1).optional(),
});
export type BulkWorkflowInput = z.output<typeof BulkInput>;

interface BulkData {
  rows: Record<string, string>[];
}

/** Slot names present in a design. */
export function designSlots(design: Design): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  for (const page of pages(design)) {
    for (const n of descendants(design, page.id)) {
      const slot = n.meta?.slot;
      if (typeof slot === "string" && slot) out.set(slot, [...(out.get(slot) ?? []), n]);
    }
  }
  return out;
}

async function fitText(
  host: DocHost,
  node: TextNode,
  text: string,
): Promise<Record<string, unknown>> {
  const style = node.runs[0]?.style;
  const runs = [style ? { text, style } : { text }];
  const set: Record<string, unknown> = { runs };
  const measure = async (size: number) =>
    (
      await host.measure([
        {
          text: runs,
          style: { ...node.style, fontSize: size },
          paragraph: node.paragraph,
          ...(node.autoResize === "width" ? {} : { width: node.width }),
        },
      ])
    )[0];
  let m = await measure(node.style.fontSize);
  if (node.autoResize === "none" && m && m.h > node.height + 0.5) {
    // Fixed boxes shrink text (down to 60 %) instead of overflowing.
    let lo = node.style.fontSize * 0.6;
    let hi = node.style.fontSize;
    for (let i = 0; i < 12 && hi - lo > 0.25; i++) {
      const mid = (lo + hi) / 2;
      const r = await measure(mid);
      if (r && r.h <= node.height + 0.5) lo = mid;
      else hi = mid;
    }
    set.style = { ...node.style, fontSize: Math.floor(lo * 4) / 4 };
    m = await measure(Math.floor(lo * 4) / 4);
  } else if (m) {
    if (node.autoResize === "width") set.width = Math.ceil(m.w);
    if (node.autoResize !== "none") set.height = Math.ceil(m.h);
  }
  return set;
}

async function imageFor(
  env: WorkflowEnv,
  host: DocHost,
  design: Design,
  value: string,
  slot: string,
): Promise<{ assetId: Id; width?: number; height?: number; op?: Op } | undefined> {
  if (design.assets[value])
    return {
      assetId: value,
      ...(design.assets[value]?.width
        ? { width: design.assets[value].width, height: design.assets[value].height }
        : {}),
    };
  if (!/^https?:\/\//i.test(value)) return undefined;
  const doFetch = env.fetch ?? defaultFetch();
  const res = await doFetch(value, env.signal ? { signal: env.signal } : {});
  if (!res.ok) throw new Error(`image for slot "${slot}" could not be downloaded (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = sniffMime(bytes) ?? res.headers.get("content-type")?.split(";")[0] ?? "";
  if (!mime.startsWith("image/")) throw new Error(`"${value}" is not an image`);
  const asset = await host.assets.upload(bytes, mime, { name: `${slot} image`, source: "upload" });
  return {
    assetId: asset.id,
    ...(asset.width ? { width: asset.width, height: asset.height } : {}),
    op: { op: "asset", set: { [asset.id]: asset } },
  };
}

export const bulkWorkflow: WorkflowDefinition<BulkWorkflowInput, BulkData> = {
  kind: "bulk",
  label: "Bulk create",
  inputSchema: BulkInput as unknown as z.ZodType<BulkWorkflowInput>,
  init() {
    return {
      data: { rows: [] },
      steps: [{ id: "parse", type: "parse", label: "Read CSV and check slots" }],
    };
  },
  estimate() {
    // Merging is deterministic (no AI calls), so it costs no credits.
    return estimateCredits([]);
  },
  async runStep(step, state, env) {
    const input = state.input;
    if (step.type === "parse") {
      const table = parseCsv(input.csv, input.delimiter);
      const missingColumns = Object.keys(input.mapping).filter((c) => !table.headers.includes(c));
      if (missingColumns.length)
        throw new Error(`CSV has no column(s): ${missingColumns.join(", ")}`);
      const template = await env.loadDesign(input.designId);
      const slots = designSlots(template);
      const missingSlots = [...new Set(Object.values(input.mapping))].filter((s) => !slots.has(s));
      if (missingSlots.length)
        throw new Error(`template has no slot(s): ${missingSlots.join(", ")}`);
      const rows = table.rows.slice(0, input.maxRows);
      return {
        data: { rows },
        result: {
          rows: rows.length,
          truncated: table.rows.length > rows.length,
          slots: [...slots.keys()],
        },
        appendSteps: rows.map((_, i) => ({
          id: `row:${i + 1}`,
          type: "row",
          label: `Row ${i + 1}`,
          params: { index: i },
          optional: true,
        })),
      };
    }
    const index = Number(step.params.index);
    const row = state.data.rows[index];
    if (!row) throw new Error(`row ${index + 1} is missing`);
    const template = await env.loadDesign(input.designId);
    const name = (input.nameColumn && row[input.nameColumn]) || `${template.name} · ${index + 1}`;
    const { designId, host } = await env.createDesign({
      name,
      kind: template.kind,
      from: template,
      ...(template.brandKitId ? { brandKitId: template.brandKitId } : {}),
    });
    const design = host.getDesign();
    const slots = designSlots(design);
    const ops: Op[] = [];
    const warnings: string[] = [];
    for (const [column, slot] of Object.entries(input.mapping)) {
      const value = row[column] ?? "";
      for (const node of slots.get(slot) ?? []) {
        if (node.type === "text") {
          ops.push({ op: "update", id: node.id, set: await fitText(host, node, value) });
        } else if (
          node.type === "image" ||
          ("fills" in node && node.fills.some((f) => f.type === "image"))
        ) {
          if (!value) continue;
          const img = await imageFor(env, host, design, value, slot);
          if (!img) {
            warnings.push(
              `row ${index + 1}: "${value}" is not an image URL or asset id for slot "${slot}"`,
            );
            continue;
          }
          if (img.op) ops.push(img.op);
          if (node.type === "image")
            ops.push({
              op: "update",
              id: node.id,
              set: {
                assetId: img.assetId,
                crop: coverCrop(img.width, img.height, node.width, node.height),
              },
            });
          else if ("fills" in node)
            ops.push({
              op: "update",
              id: node.id,
              set: {
                fills: node.fills.map((f) =>
                  f.type === "image" ? { ...f, assetId: img.assetId } : f,
                ),
              },
            });
        } else if (node.type === "qr") {
          ops.push({ op: "update", id: node.id, set: { data: value } });
        } else if ("fills" in node) {
          const hex = normalizeHex(value);
          if (hex && isColor(hex))
            ops.push({
              op: "update",
              id: node.id,
              set: { fills: [{ type: "solid", color: hex }] },
            });
          else if (value)
            warnings.push(`row ${index + 1}: "${value}" is not a color for slot "${slot}"`);
        }
      }
    }
    if (ops.length) await applyWorkflowOps(host, ops, `Merge row ${index + 1}`, state.id);
    return {
      outputs: [{ designId, label: name, kind: template.kind }],
      result: { designId, warnings },
    };
  },
};
