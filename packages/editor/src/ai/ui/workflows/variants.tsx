"use client";

import { Checkbox, cn, Slider, Textarea } from "@desyn/ui";
import { ImageIcon, LayoutGrid, Palette, Type } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useEditorStore } from "../../../context.tsx";
import type { ModalDef, ModalProps } from "../../../shell/extensions.ts";
import { VARIANT_AXES, type VariantAxis } from "../../core/prompt.ts";
import { useAiSession } from "../hooks.ts";
import { FieldLabel, useWorkflowEstimate, WorkflowDialog } from "./common.tsx";

const AXES: Record<VariantAxis, { label: string; hint: string; icon: ReactNode }> = {
  copy: { label: "Copy", hint: "Headlines and wording change; the look stays.", icon: <Type /> },
  color: { label: "Color", hint: "Palettes change; layout and copy stay.", icon: <Palette /> },
  layout: { label: "Layout", hint: "Composition changes; content stays.", icon: <LayoutGrid /> },
  image: { label: "Image", hint: "Imagery changes; everything else stays.", icon: <ImageIcon /> },
};

function VariantsDialog({ props, close }: ModalProps) {
  const session = useAiSession();
  const design = useEditorStore((s) => s.doc.design);
  const [count, setCount] = useState(
    typeof props.count === "number" ? Math.min(8, Math.max(1, props.count)) : 3,
  );
  const [axis, setAxis] = useState<VariantAxis>(
    VARIANT_AXES.includes(props.axis as VariantAxis) ? (props.axis as VariantAxis) : "copy",
  );
  const [keep, setKeep] = useState<string[]>(["logo"]);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const roles = useMemo(() => {
    const set = new Set<string>();
    for (const n of Object.values(design?.nodes ?? {}))
      if (n.role && n.role !== "background") set.add(n.role);
    return [...set].sort();
  }, [design]);
  const input = {
    count,
    axis,
    keep: keep.filter((r) => roles.includes(r)),
    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
  };
  const estimate = useWorkflowEstimate("variants", input);
  const start = async () => {
    setBusy(true);
    const id = await session.startWorkflow(
      "variants",
      input,
      `${count} ${AXES[axis].label.toLowerCase()} variants`,
    );
    setBusy(false);
    if (id) close();
  };
  return (
    <WorkflowDialog
      action="workflow.variants"
      title={
        <>
          <em className="text-accent">variants</em> to test
        </>
      }
      description="Deliberately different alternatives along one axis, each a new design next to this one."
      close={close}
      estimate={estimate}
      startLabel={`Create ${count} variant${count === 1 ? "" : "s"}`}
      canStart
      onStart={() => void start()}
      busy={busy}
    >
      <FieldLabel>What should differ?</FieldLabel>
      <fieldset className="m-0 min-w-0 border-0 p-0 grid grid-cols-2 gap-2">
        <legend className="sr-only">Variant axis</legend>
        {VARIANT_AXES.map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={axis === a}
            onClick={() => setAxis(a)}
            className={cn(
              "flex items-start gap-2.5 rounded-card p-3 text-left transition-colors [&_svg]:size-4",
              axis === a ? "bg-accent-wash" : "bg-fg/[0.04] hover:bg-fg/[0.07]",
            )}
          >
            <span className={axis === a ? "text-accent" : "text-fg-muted"} aria-hidden>
              {AXES[a].icon}
            </span>
            <span>
              <span className="block text-sm text-fg">{AXES[a].label}</span>
              <span className="block text-2xs text-fg-muted">{AXES[a].hint}</span>
            </span>
          </button>
        ))}
      </fieldset>
      <div className="mt-5 flex items-center gap-3">
        <FieldLabel>How many</FieldLabel>
        <Slider
          aria-label="Number of variants"
          min={1}
          max={8}
          step={1}
          value={[count]}
          onValueChange={(v) => setCount(v[0] ?? count)}
          className="-mt-1.5 flex-1"
        />
        <span className="-mt-1.5 w-6 text-right font-mono text-sm text-fg">{count}</span>
      </div>
      {roles.length > 0 ? (
        <div className="mt-4">
          <FieldLabel>Keep identical</FieldLabel>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {roles.map((r) => (
              <Checkbox
                key={r}
                checked={keep.includes(r)}
                onCheckedChange={(v) =>
                  setKeep((k) => (v === true ? [...k, r] : k.filter((x) => x !== r)))
                }
                label={<span className="text-xs text-fg-secondary">{r}</span>}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-4">
        <FieldLabel htmlFor="variants-notes">Direction (optional)</FieldLabel>
        <Textarea
          id="variants-notes"
          minRows={2}
          autoResize
          placeholder="e.g. one playful, one premium, one urgent"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
    </WorkflowDialog>
  );
}

export const variantsModal: ModalDef = { id: "ai.workflow.variants", component: VariantsDialog };
