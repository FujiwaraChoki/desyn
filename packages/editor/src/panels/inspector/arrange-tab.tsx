"use client";

import { SegmentedControl } from "@desyn/ui";
import { MousePointerClick } from "lucide-react";
import { useState } from "react";
import { useEditorStore } from "../../context.tsx";
import { CommandButton } from "../../shell/command-items.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { InspectorSection, PanelEmpty } from "../ui/primitives.tsx";

/**
 * Arrange tab: alignment (to the selection or the page), distribution, tidy up, match size, layer order,
 * grouping and transforms. Every button is a registry command, so shortcuts, enablement and labels match the
 * menus and the command palette.
 */
export function ArrangeTab(_props: SlotProps) {
  const count = useEditorStore((s) => s.selection.length);
  const [to, setTo] = useState<"selection" | "page">("selection");
  if (count === 0) {
    return (
      <PanelEmpty
        icon={<MousePointerClick />}
        title={
          <>
            select to <em className="text-accent">arrange</em>
          </>
        }
        description="Align, distribute, reorder and group the selected layers."
      />
    );
  }
  const alignTo = count === 1 ? "page" : to;
  const align = (id: string) => <CommandButton key={id} id={id} args={{ to: alignTo }} size="sm" />;
  return (
    <div className="flex flex-col">
      <InspectorSection title="Align">
        {count > 1 ? (
          <SegmentedControl<"selection" | "page">
            size="sm"
            fullWidth
            aria-label="Align relative to"
            value={to}
            onValueChange={setTo}
            options={[
              { value: "selection", label: "To selection" },
              { value: "page", label: "To page" },
            ]}
          />
        ) : (
          <p className="text-2xs text-fg-muted">One layer aligns to the page.</p>
        )}
        <div className="flex justify-between gap-0.5 rounded-[10px] bg-surface-2 p-1">
          {["arrange.alignLeft", "arrange.alignCenter", "arrange.alignRight"].map(align)}
          <span aria-hidden className="mx-0.5 w-px bg-line-subtle" />
          {["arrange.alignTop", "arrange.alignMiddle", "arrange.alignBottom"].map(align)}
        </div>
      </InspectorSection>
      <InspectorSection title="Distribute & size">
        <div className="flex flex-wrap gap-0.5">
          <CommandButton id="arrange.distributeHorizontal" size="sm" />
          <CommandButton id="arrange.distributeVertical" size="sm" />
          <CommandButton id="arrange.tidy" size="sm" />
          <span aria-hidden className="mx-1 w-px bg-line-subtle" />
          <CommandButton id="arrange.matchWidth" size="sm" />
          <CommandButton id="arrange.matchHeight" size="sm" />
        </div>
        {count < 3 ? (
          <p className="text-2xs text-fg-muted">Distribute needs three or more layers.</p>
        ) : null}
      </InspectorSection>
      <InspectorSection title="Layer order">
        <div className="flex gap-0.5">
          <CommandButton id="arrange.bringToFront" size="sm" />
          <CommandButton id="arrange.bringForward" size="sm" />
          <CommandButton id="arrange.sendBackward" size="sm" />
          <CommandButton id="arrange.sendToBack" size="sm" />
        </div>
      </InspectorSection>
      <InspectorSection title="Structure">
        <div className="flex flex-wrap gap-0.5">
          <CommandButton id="edit.group" size="sm" />
          <CommandButton id="edit.ungroup" size="sm" />
          <CommandButton id="edit.frameSelection" size="sm" />
          <CommandButton id="edit.autoLayout" size="sm" />
          <CommandButton id="edit.useAsMask" size="sm" />
        </div>
      </InspectorSection>
      <InspectorSection title="Transform">
        <div className="flex flex-wrap gap-0.5">
          <CommandButton id="edit.flipHorizontal" size="sm" />
          <CommandButton id="edit.flipVertical" size="sm" />
          <CommandButton id="edit.toggleLock" size="sm" />
          <CommandButton id="edit.toggleVisibility" size="sm" />
          <CommandButton id="edit.duplicate" size="sm" />
          <CommandButton id="edit.delete" size="sm" />
        </div>
      </InspectorSection>
    </div>
  );
}
