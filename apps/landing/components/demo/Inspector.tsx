"use client";

import type { DemoDesign, DemoLayer } from "@/lib/demo/types";
import { ARTBOARD } from "@/lib/demo/types";

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-[6px] bg-surface-2 px-2.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <span className="ml-auto font-mono text-[12px] tabular-nums text-fg/85">{value}</span>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  const none = color === "transparent";
  return (
    <span
      className="size-4 shrink-0 rounded-[4px] border border-fg/15"
      style={{
        background: none
          ? "repeating-conic-gradient(rgb(var(--fg-rgb)/.15) 0 25%, transparent 0 50%) 0 0/8px 8px"
          : color,
      }}
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-fg/[0.07] px-4 py-3.5">
      <h3 className="mb-2.5 font-sans text-[11px] font-medium text-subtle">{title}</h3>
      {children}
    </section>
  );
}

function colorsOf(l: DemoLayer): string[] {
  if (l.kind === "image") return l.artColors ?? [];
  return [l.fill, l.fill2, l.stroke, l.color].filter((c): c is string => Boolean(c));
}

export function Inspector({
  design,
  selected,
}: {
  design: DemoDesign | null;
  selected: string | null;
}) {
  const layer = design?.layers.find((l) => l.id === selected);

  if (!design || !layer) {
    const palette = design
      ? [...new Set(design.layers.flatMap(colorsOf))]
          .filter((c) => c !== "transparent")
          .slice(0, 10)
      : [];
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-10 items-center px-4">
          <span className="text-[11px] font-medium text-subtle">Design</span>
        </div>
        <Section title="Page">
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="W" value={ARTBOARD.width} />
            <Field label="H" value={ARTBOARD.height} />
          </div>
          <p className="mt-2.5 text-[12px] text-subtle">Social post · 4:5 · px</p>
        </Section>
        {palette.length > 0 && (
          <Section title="Colours in use">
            <div className="flex flex-wrap gap-1.5">
              {palette.map((c) => (
                <span
                  key={c}
                  title={c}
                  className="block size-6 rounded-[6px] border border-fg/10"
                  style={{ background: c }}
                />
              ))}
            </div>
          </Section>
        )}
        <p className="mt-auto px-4 pb-4 text-[12px] leading-5 text-subtle">
          Select a layer to inspect it. Drag it on the canvas, or ask the AI to move it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center justify-between gap-2 px-4">
        <span className="truncate text-[12.5px] text-fg">{layer.name}</span>
        <span className="shrink-0 rounded-full border border-fg/10 px-2 py-0.5 font-mono text-[10px] text-subtle">
          {layer.role}
        </span>
      </div>
      <Section title="Position">
        <div className="grid grid-cols-2 gap-1.5">
          <Field label="X" value={Math.round(layer.x)} />
          <Field label="Y" value={Math.round(layer.y)} />
          <Field label="W" value={Math.round(layer.width)} />
          <Field label="H" value={Math.round(layer.height)} />
        </div>
      </Section>
      {(layer.kind === "text" || layer.kind === "button") && (
        <Section title="Text">
          <div className="flex flex-col gap-1.5">
            <Field
              label="Font"
              value={layer.font === "serif" ? "Instrument Serif" : "Instrument Sans"}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Field label="Size" value={layer.fontSize ?? 0} />
              <Field label="Style" value={layer.italic ? "Italic" : "Regular"} />
            </div>
            <Field label="Align" value={layer.align ?? "center"} />
          </div>
        </Section>
      )}
      <Section title="Fill">
        <div className="flex flex-col gap-1.5">
          {[...new Set(colorsOf(layer))].map((c) => (
            <div key={c} className="flex h-8 items-center gap-2 rounded-[6px] bg-surface-2 px-2.5">
              <Swatch color={c} />
              <span className="font-mono text-[12px] uppercase text-fg/80">
                {c === "transparent" ? "None" : c}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Opacity">
        <div className="flex items-center gap-3">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-fg/10">
            <div
              className="h-full rounded-full bg-sun"
              style={{ width: `${Math.round(layer.opacity * 100)}%` }}
            />
          </div>
          <span className="w-9 text-right font-mono text-[12px] text-fg/70">
            {Math.round(layer.opacity * 100)}%
          </span>
        </div>
      </Section>
    </div>
  );
}
