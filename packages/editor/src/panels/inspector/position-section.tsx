"use client";

import { FlipHorizontal2, FlipVertical2, Link2, Link2Off, RotateCw } from "lucide-react";
import { positionOps, rotationOps, sizeOps } from "../lib/geometry.ts";
import { useLiveEdit } from "../lib/live.ts";
import { common, round2, updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton } from "../ui/primitives.tsx";
import { Num } from "./fields.tsx";
import type { InspectorTarget } from "./hooks.ts";

/** X / Y / W / H / rotation (parent space), aspect lock and flips. Typed values accept math (`120*2`). */
export function PositionSection({ target }: { target: InspectorTarget }) {
  const { ids, nodes, editable } = target;
  const move = useLiveEdit("Move");
  const resize = useLiveEdit("Resize");
  const rotate = useLiveEdit("Rotate");
  const misc = useLiveEdit("Transform");
  const x = common(nodes, (n) => round2(n.x));
  const y = common(nodes, (n) => round2(n.y));
  const w = common(nodes, (n) => round2(n.width));
  const h = common(nodes, (n) => round2(n.height));
  const rot = common(nodes, (n) => round2(n.rotation));
  const locked = nodes.length > 0 && nodes.every((n) => n.aspectLocked);
  const isLine = nodes.every((n) => n.type === "line");
  const disabled = !editable || nodes.every((n) => n.locked);

  return (
    <InspectorSection
      title="Position"
      actions={
        <>
          <MiniButton
            label="Flip horizontal"
            disabled={disabled}
            onClick={() =>
              misc.apply((d) => updateEach(d, ids, (n) => ({ flipX: n.flipX ? undefined : true })))
            }
          >
            <FlipHorizontal2 />
          </MiniButton>
          <MiniButton
            label="Flip vertical"
            disabled={disabled}
            onClick={() =>
              misc.apply((d) => updateEach(d, ids, (n) => ({ flipY: n.flipY ? undefined : true })))
            }
          >
            <FlipVertical2 />
          </MiniButton>
          <MiniButton
            label="Rotate 90°"
            disabled={disabled}
            onClick={() => misc.apply((d) => rotationOps(d, ids, 90, true))}
          >
            <RotateCw />
          </MiniButton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label="X"
          aria-label="X position"
          value={x}
          disabled={disabled}
          onLive={(v) => move.preview((d) => positionOps(d, ids, { x: v }))}
          onCommit={(v) => move.commit((d) => positionOps(d, ids, { x: v }))}
        />
        <Num
          label="Y"
          aria-label="Y position"
          value={y}
          disabled={disabled}
          onLive={(v) => move.preview((d) => positionOps(d, ids, { y: v }))}
          onCommit={(v) => move.commit((d) => positionOps(d, ids, { y: v }))}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Num
          label="W"
          aria-label="Width"
          value={w}
          min={isLine ? 0 : 1}
          disabled={disabled}
          onLive={(v) => resize.preview((d) => sizeOps(d, ids, { width: v }, locked))}
          onCommit={(v) => resize.commit((d) => sizeOps(d, ids, { width: v }, locked))}
        />
        <MiniButton
          label={locked ? "Unlock proportions" : "Lock proportions"}
          active={locked}
          disabled={disabled}
          onClick={() =>
            misc.apply((d) =>
              updateEach(d, ids, () => ({ aspectLocked: locked ? undefined : true })),
            )
          }
        >
          {locked ? <Link2 /> : <Link2Off />}
        </MiniButton>
        <Num
          label="H"
          aria-label="Height"
          value={isLine ? 0 : h}
          min={1}
          disabled={disabled || isLine}
          onLive={(v) => resize.preview((d) => sizeOps(d, ids, { height: v }, locked))}
          onCommit={(v) => resize.commit((d) => sizeOps(d, ids, { height: v }, locked))}
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label={<RotateCw className="size-3" />}
          aria-label="Rotation"
          scrubTitle="Rotation"
          unit="°"
          step={1}
          value={rot}
          disabled={disabled}
          onLive={(v) => rotate.preview((d) => rotationOps(d, ids, v))}
          onCommit={(v) => rotate.commit((d) => rotationOps(d, ids, v))}
        />
      </div>
    </InspectorSection>
  );
}
