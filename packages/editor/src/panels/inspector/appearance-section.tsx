"use client";

import { BLEND_MODES, type BlendMode, type Design, type Node } from "@desyn/schema";
import { Select, Slider } from "@desyn/ui";
import { Eye, EyeOff, Scan } from "lucide-react";
import { useState } from "react";
import { useLiveEdit } from "../lib/live.ts";
import { common, round2, updateEach } from "../lib/ops.ts";
import { InspectorSection, MiniButton, Row } from "../ui/primitives.tsx";
import { Num, Percent } from "./fields.tsx";
import type { InspectorTarget } from "./hooks.ts";

/** Opacity, blend mode, visibility, and corner radius (uniform or per corner) with corner smoothing. */

const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "Color dodge",
  "color-burn": "Color burn",
  "hard-light": "Hard light",
  "soft-light": "Soft light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

const RADIUS_TYPES = new Set(["rect", "frame", "image", "video", "boolean"]);
const SMOOTHING_TYPES = new Set(["rect", "frame", "boolean"]);

type Corners = [number, number, number, number];

function corners(n: Node): Corners {
  const r = (n as Node & { cornerRadius?: number | Corners }).cornerRadius ?? 0;
  return typeof r === "number" ? [r, r, r, r] : r;
}

export function AppearanceSection({ target }: { target: InspectorTarget }) {
  const { ids, nodes, editable } = target;
  const opacityEdit = useLiveEdit("Opacity");
  const radiusEdit = useLiveEdit("Corner radius");
  const misc = useLiveEdit("Appearance");
  const opacity = common(nodes, (n) => n.opacity);
  const blend = common(nodes, (n) => n.blend);
  const allHidden = nodes.every((n) => !n.visible);
  const radiusNodes = nodes.filter((n) => RADIUS_TYPES.has(n.type));
  const radiusIds = radiusNodes.map((n) => n.id);
  const perCornerStored = radiusNodes.some((n) =>
    Array.isArray((n as Node & { cornerRadius?: unknown }).cornerRadius),
  );
  const [perCorner, setPerCorner] = useState(perCornerStored);
  const showCorners = perCorner || perCornerStored;
  const uniform = common(radiusNodes, (n) => {
    const c = corners(n);
    return c.every((v) => v === c[0]) ? round2(c[0]) : Number.NaN;
  });
  const smoothingNodes = nodes.filter((n) => SMOOTHING_TYPES.has(n.type));
  const smoothing = common(
    smoothingNodes,
    (n) => (n as Node & { cornerSmoothing?: number }).cornerSmoothing ?? 0,
  );
  const disabled = !editable;

  const setCorner = (index: number | "all", v: number) => (d: Design) =>
    updateEach(d, radiusIds, (n) => {
      const value = Math.max(0, round2(v));
      if (index === "all") return { cornerRadius: value };
      const c = [...corners(n)] as Corners;
      c[index] = value;
      return { cornerRadius: c.every((x) => x === c[0]) && !showCorners ? c[0] : c };
    });

  return (
    <InspectorSection
      title="Layer"
      actions={
        <MiniButton
          label={allHidden ? "Show" : "Hide"}
          disabled={disabled}
          onClick={() => misc.apply((d) => updateEach(d, ids, () => ({ visible: allHidden })))}
        >
          {allHidden ? <EyeOff /> : <Eye />}
        </MiniButton>
      }
    >
      <div className="flex items-center gap-1.5">
        <Percent
          label="Opacity"
          aria-label="Opacity"
          scrubTitle="Opacity"
          value={opacity}
          disabled={disabled}
          className="max-w-[112px]"
          onLive={(v) => opacityEdit.preview((d) => updateEach(d, ids, () => ({ opacity: v })))}
          onCommit={(v) => opacityEdit.commit((d) => updateEach(d, ids, () => ({ opacity: v })))}
        />
        <Select<BlendMode>
          aria-label="Blend mode"
          size="sm"
          value={blend ?? undefined}
          placeholder="Mixed"
          disabled={disabled}
          onValueChange={(v) => misc.apply((d) => updateEach(d, ids, () => ({ blend: v })))}
          options={BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] }))}
          className="min-w-0 flex-1"
        />
      </div>
      {radiusNodes.length > 0 ? (
        <>
          <div className="flex items-center gap-1.5">
            <Num
              label="R"
              aria-label="Corner radius"
              scrubTitle="Corner radius"
              min={0}
              value={uniform === null || Number.isNaN(uniform) ? null : uniform}
              disabled={disabled}
              onLive={(v) => radiusEdit.preview(setCorner("all", v))}
              onCommit={(v) => radiusEdit.commit(setCorner("all", v))}
            />
            <MiniButton
              label="Independent corners"
              active={showCorners}
              disabled={disabled}
              onClick={() => setPerCorner((p) => !p)}
            >
              <Scan />
            </MiniButton>
          </div>
          {showCorners ? (
            <div className="grid grid-cols-2 gap-1.5">
              {(["Top left", "Top right", "Bottom right", "Bottom left"] as const).map(
                (label, i) => (
                  <Num
                    key={label}
                    label={["↖", "↗", "↘", "↙"][i]}
                    aria-label={`${label} radius`}
                    min={0}
                    value={common(radiusNodes, (n) => round2(corners(n)[i] as number))}
                    disabled={disabled}
                    onLive={(v) => radiusEdit.preview(setCorner(i, v))}
                    onCommit={(v) => radiusEdit.commit(setCorner(i, v))}
                  />
                ),
              )}
            </div>
          ) : null}
          {smoothingNodes.length > 0 ? (
            <Row label="Smoothing">
              <Slider
                aria-label="Corner smoothing"
                size="sm"
                min={0}
                max={100}
                step={1}
                value={[Math.round((smoothing ?? 0) * 100)]}
                disabled={disabled}
                formatValue={(v) => `${v}%`}
                showValue
                onValueChange={([v]) =>
                  radiusEdit.preview((d) =>
                    updateEach(
                      d,
                      smoothingNodes.map((n) => n.id),
                      () => ({ cornerSmoothing: (v ?? 0) / 100 }),
                    ),
                  )
                }
                onValueCommit={([v]) =>
                  radiusEdit.commit((d) =>
                    updateEach(
                      d,
                      smoothingNodes.map((n) => n.id),
                      () => ({
                        cornerSmoothing: v ? v / 100 : undefined,
                      }),
                    ),
                  )
                }
              />
            </Row>
          ) : null}
        </>
      ) : null}
    </InspectorSection>
  );
}
