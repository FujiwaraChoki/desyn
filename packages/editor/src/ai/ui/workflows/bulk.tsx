"use client";

import { makeTransaction } from "@desyn/doc-ops";
import type { Design, Id, Node, Op } from "@desyn/schema";
import { Button, Callout, Select, Textarea } from "@desyn/ui";
import { FileSpreadsheet, Tags, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useEditorStore } from "../../../context.tsx";
import type { ModalDef, ModalProps } from "../../../shell/extensions.ts";
import { useAiSession } from "../hooks.ts";
import { FieldLabel, useAiModule, useWorkflowEstimate, WorkflowDialog } from "./common.tsx";
import { PagePreview, useAssetUrls } from "./page-preview.tsx";

const SKIP = "__skip";
const NONE = "__none";
const SLOT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "qr",
  "rect",
  "frame",
  "ellipse",
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Slots from semantic roles for designs that have none yet: every text / image / QR layer with a role gets
 * `meta.slot` = its role (numbered when a role repeats), so a CSV can be mapped onto the design's roles.
 */
export function roleSlotOps(design: Design): Op[] {
  const seen = new Map<string, number>();
  const ops: Op[] = [];
  for (const n of Object.values(design.nodes)) {
    if (!n.role || !SLOT_TYPES.has(n.type) || n.role === "background" || n.role === "decoration")
      continue;
    if (typeof n.meta?.slot === "string") continue;
    const k = (seen.get(n.role) ?? 0) + 1;
    seen.set(n.role, k);
    ops.push({
      op: "update",
      id: n.id,
      set: { meta: { ...(n.meta ?? {}), slot: k === 1 ? n.role : `${n.role}-${k}` } },
    });
  }
  return ops;
}

/** A copy of the design with the first row's text written into text slots (for the preview). */
function previewRow(
  design: Design,
  slots: Map<string, Node[]>,
  mapping: Record<string, string>,
  row: Record<string, string>,
): Design {
  const nodes = { ...design.nodes };
  for (const [column, slot] of Object.entries(mapping)) {
    const value = row[column];
    if (value === undefined) continue;
    for (const n of slots.get(slot) ?? []) {
      if (n.type !== "text") continue;
      const style = n.runs[0]?.style;
      nodes[n.id] = { ...n, runs: [style ? { text: value, style } : { text: value }] };
    }
  }
  return { ...design, nodes };
}

function BulkDialog({ editor, close }: ModalProps) {
  const session = useAiSession();
  const ai = useAiModule();
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const urls = useAssetUrls(editor, design);
  const file = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [nameColumn, setNameColumn] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);

  const table = useMemo(() => {
    if (!ai || !csv.trim()) return null;
    try {
      return ai.parseCsv(csv);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "This CSV could not be read." };
    }
  }, [ai, csv]);
  const slots = useMemo(
    () => (ai && design ? ai.designSlots(design) : new Map<string, Node[]>()),
    [ai, design],
  );
  const slotNames = [...slots.keys()].sort();
  const headers = table && "headers" in table ? table.headers : [];
  const rows = table && "rows" in table ? table.rows : [];

  // Columns named like a slot map themselves until the user changes them.
  const effective = useMemo(() => {
    const out: Record<string, string> = {};
    for (const h of headers) {
      const picked = mapping[h];
      if (picked) {
        if (picked !== SKIP) out[h] = picked;
        continue;
      }
      const auto = slotNames.find((s) => norm(s) === norm(h));
      if (auto) out[h] = auto;
    }
    return out;
  }, [headers, mapping, slotNames]);

  const input =
    csv.trim() && Object.keys(effective).length > 0
      ? {
          csv,
          mapping: effective,
          maxRows: Math.min(1000, Math.max(1, rows.length)),
          ...(nameColumn !== NONE ? { nameColumn } : {}),
        }
      : null;
  const estimate = useWorkflowEstimate("bulk", input);

  const applyRoleSlots = async () => {
    if (!design) return;
    await editor.apply(
      () => {
        const ops = roleSlotOps(design);
        return ops.length ? makeTransaction(ops, "Use roles as slots") : null;
      },
      { label: "Use roles as slots" },
    );
  };

  const start = async () => {
    if (!input) return;
    setBusy(true);
    const id = await session.startWorkflow("bulk", input, `Bulk create · ${rows.length} rows`);
    setBusy(false);
    if (id) close();
  };

  const preview =
    design && pageId && rows[0] ? previewRow(design, slots, effective, rows[0]) : null;
  const roleCandidates = design ? roleSlotOps(design).length : 0;

  return (
    <WorkflowDialog
      action="workflow.bulk"
      title={
        <>
          bulk <em className="text-accent">create</em>
        </>
      }
      description="One design per spreadsheet row: map columns to the design's slots (text, images, colors, QR codes)."
      close={close}
      estimate={estimate}
      startLabel={`Create ${rows.length} design${rows.length === 1 ? "" : "s"}`}
      canStart={!!input && rows.length > 0}
      onStart={() => void start()}
      busy={busy}
      {...(input ? {} : { estimateHint: "Map columns to slots to see the cost" })}
      size="xl"
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="min-w-0">
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="bulk-csv">Data</FieldLabel>
            <Button
              size="xs"
              variant="ghost"
              leadingIcon={<Upload />}
              onClick={() => file.current?.click()}
            >
              Upload CSV
            </Button>
            <input
              ref={file}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
                e.target.value = "";
              }}
            />
          </div>
          <Textarea
            id="bulk-csv"
            minRows={6}
            maxRows={10}
            autoResize
            className="font-mono text-xs"
            placeholder={"name,headline,photo\nAda,Hello Lisbon,https://…/ada.jpg"}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          {table && "error" in table ? (
            <Callout tone="danger" className="mt-2 text-xs">
              {table.error}
            </Callout>
          ) : null}
          {rows.length > 0 ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-2xs text-fg-muted">
              <FileSpreadsheet className="size-3.5" aria-hidden />
              {rows.length} rows · {headers.length} columns
            </p>
          ) : null}
          {slotNames.length === 0 ? (
            <Callout tone="info" className="mt-3 text-xs" title="This design has no slots yet">
              {roleCandidates > 0 ? (
                <>
                  <p>
                    Turn its {roleCandidates} named layers (headline, photo, price…) into slots to
                    map columns onto them.
                  </p>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="mt-2"
                    leadingIcon={<Tags />}
                    onClick={() => void applyRoleSlots()}
                  >
                    Use layer roles as slots
                  </Button>
                </>
              ) : (
                "Give layers a role (Layers panel) or a slot name, then map columns to them."
              )}
            </Callout>
          ) : null}
          {headers.length > 0 && slotNames.length > 0 ? (
            <div className="mt-4">
              <FieldLabel>Columns → slots</FieldLabel>
              <ul className="flex flex-col gap-1.5">
                {headers.map((h) => (
                  <li
                    key={h}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
                  >
                    <span className="truncate font-mono text-xs text-fg-secondary">{h}</span>
                    <Select
                      size="sm"
                      aria-label={`Slot for ${h}`}
                      value={effective[h] ?? SKIP}
                      onValueChange={(v) => setMapping((m) => ({ ...m, [h]: v }))}
                      options={[
                        { value: SKIP, label: "Skip" },
                        ...slotNames.map((s) => ({
                          value: s,
                          label: `${s} · ${(slots.get(s) ?? [])
                            .map((n) => n.type)
                            .filter((t, i, a) => a.indexOf(t) === i)
                            .join("/")}`,
                        })),
                      ]}
                    />
                  </li>
                ))}
              </ul>
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                <span className="text-xs text-fg-secondary">Name designs by</span>
                <Select
                  size="sm"
                  aria-label="Name designs by"
                  value={nameColumn}
                  onValueChange={setNameColumn}
                  options={[
                    { value: NONE, label: "Row number" },
                    ...headers.map((h) => ({ value: h, label: h })),
                  ]}
                />
              </div>
            </div>
          ) : null}
        </div>
        <div className="min-w-0">
          <FieldLabel>First row</FieldLabel>
          <div className="grid aspect-[4/3] place-items-center rounded-card bg-canvas p-3">
            {preview && pageId ? (
              <PagePreview
                design={preview}
                pageId={pageId as Id}
                urls={urls}
                label="First row preview"
                className="max-h-full max-w-full shadow-page"
              />
            ) : (
              <span className="px-6 text-center text-xs text-fg-muted">
                Paste or upload a CSV to preview the first design.
              </span>
            )}
          </div>
          {rows.length > 0 ? (
            <div className="mt-3 max-h-36 overflow-auto rounded-card border border-line-subtle">
              <table className="w-full text-left text-2xs">
                <thead className="sticky top-0 bg-surface-2">
                  <tr>
                    {headers.map((h) => (
                      <th key={h} className="px-2 py-1 font-medium text-fg-secondary">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((r, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview rows of a parsed table
                    <tr key={i} className="border-t border-line-subtle">
                      {headers.map((h) => (
                        <td key={h} className="max-w-32 truncate px-2 py-1 text-fg-muted">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </WorkflowDialog>
  );
}

export const bulkModal: ModalDef = { id: "ai.workflow.bulk", component: BulkDialog };
