"use client";

import { FONT_PAIRINGS, type FontPairing, pairingsForKind, type TextNode } from "@desyn/schema";
import { Button, cn } from "@desyn/ui";
import { Type } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditor, useEditorStore } from "../../context.tsx";
import {
  pairingBlock,
  TEXT_EFFECTS,
  TEXT_PRESETS,
  type TextEffect,
  textFromPreset,
} from "../lib/catalog.ts";
import { loadPreviewFont } from "../lib/fonts.ts";
import { insertSubtree } from "../lib/insert.ts";
import { updateEach } from "../lib/ops.ts";
import { pageInk } from "../lib/page-color.ts";
import { ChipRow, PanelBody, PanelSection } from "../ui/primitives.tsx";

/**
 * Text: a text box, styled presets (heading, subheading, body...), font combinations from FONT_PAIRINGS
 * (previewed in their own faces, loaded lazily), and text effects for the selected text layers.
 */

const PREVIEW_FAMILY = "Instrument Sans";

export function TextPanel() {
  const editor = useEditor();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const addPreset = (id: (typeof TEXT_PRESETS)[number]["id"]) => {
    const preset = TEXT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    void insertSubtree(editor, [textFromPreset(preset, undefined, pageInk(editor))], {
      label: `Add ${preset.id}`,
    });
  };
  return (
    <PanelBody>
      <div className="pt-1">
        <Button
          variant="primary"
          size="md"
          className="w-full"
          leadingIcon={<Type />}
          disabled={!canEdit}
          onClick={() => addPreset("body")}
        >
          Add a text box
        </Button>
      </div>
      <PanelSection title="Default text styles">
        <div className="flex flex-col gap-1.5">
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!canEdit}
              onClick={() => addPreset(p.id)}
              className="group flex min-h-11 w-full cursor-pointer items-center rounded-[10px] bg-surface-2 px-3 py-2 text-left text-fg transition-[background-color,box-shadow] duration-200 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className="truncate"
                style={{
                  fontFamily: `"${PREVIEW_FAMILY}", ui-sans-serif, system-ui`,
                  fontSize: Math.max(12, Math.min(26, (p.style.fontSize ?? 24) * 0.36)),
                  fontWeight: p.style.fontWeight ?? 400,
                  fontStyle: p.style.fontStyle ?? "normal",
                  letterSpacing: `${p.style.letterSpacing ?? 0}em`,
                  textTransform: p.style.textCase === "upper" ? "uppercase" : "none",
                }}
              >
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </PanelSection>
      <TextEffects />
      <FontCombinations />
    </PanelBody>
  );
}

function TextEffects() {
  const editor = useEditor();
  const ids = useEditorStore(
    useShallow((s) =>
      s.selection.filter(
        (id) => s.doc.design?.nodes[id]?.type === "text" && !s.doc.design.nodes[id].locked,
      ),
    ),
  );
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const apply = (effect: TextEffect) =>
    void editor.apply(
      (design) =>
        updateEach(design, ids, (n) => {
          if (n.type !== "text") return null;
          const base = TEXT_EFFECTS[0]?.apply(n) ?? {};
          // Effects replace each other (except the curve, which toggles on its own).
          const patch =
            effect.id === "curve"
              ? effect.apply(n)
              : { ...base, curve: n.curve, ...effect.apply(n) };
          if (effect.id !== "hollow" && n.strokes?.length && n.style.fills.length === 0) {
            // Leaving "hollow": give the text its color back.
            const color = n.strokes[0]?.fills[0];
            if (color) (patch as Partial<TextNode>).style = { ...n.style, fills: [color] };
          }
          return patch as Record<string, unknown>;
        }),
      { label: `Text effect: ${effect.label}` },
    );
  return (
    <PanelSection title="Text effects">
      {ids.length === 0 ? (
        <p className="text-xs text-fg-muted">
          Select a text layer to style it with shadows, outlines, neon glow or a curve.
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-1.5">
        {TEXT_EFFECTS.map((e) => (
          <button
            key={e.id}
            type="button"
            disabled={ids.length === 0 || !canEdit}
            onClick={() => apply(e)}
            className="group flex flex-col items-center gap-1 rounded-[10px] bg-surface-2 py-2.5 text-fg transition-[background-color] duration-200 enabled:cursor-pointer enabled:hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-45"
          >
            <EffectSample id={e.id} />
            <span className="text-2xs text-fg-muted group-enabled:group-hover:text-fg-secondary">
              {e.label}
            </span>
          </button>
        ))}
      </div>
    </PanelSection>
  );
}

/** "Ag" rendered with a CSS approximation of each effect. */
function EffectSample({ id }: { id: string }) {
  const base = "font-serif text-[26px] leading-none";
  const styles: Record<string, React.CSSProperties> = {
    none: {},
    shadow: { textShadow: "2px 3px 6px rgb(0 0 0 / 0.45)" },
    lift: { textShadow: "0 8px 14px rgb(0 0 0 / 0.35)" },
    hollow: { color: "transparent", WebkitTextStroke: "1px var(--fg)" },
    outline: { WebkitTextStroke: "1px var(--accent)" },
    echo: {
      textShadow: "3px 3px 0 rgb(var(--accent-rgb) / 0.4), 6px 6px 0 rgb(var(--accent-rgb) / 0.2)",
    },
    neon: {
      color: "var(--accent-hi)",
      textShadow: "0 0 6px var(--accent), 0 0 14px var(--accent)",
    },
    glitch: { textShadow: "-2px 0 #ff6a1fcc, 2px 0 #5aa9ffcc" },
  };
  if (id === "curve") {
    return (
      <svg viewBox="0 0 48 28" className="h-[26px] w-12 text-fg" aria-hidden>
        <path id="dsn-curve-sample" d="M4 24 Q24 2 44 24" fill="none" />
        <text className="fill-current font-serif" fontSize="13">
          <textPath href="#dsn-curve-sample" startOffset="50%" textAnchor="middle">
            Curve
          </textPath>
        </text>
      </svg>
    );
  }
  return (
    <span aria-hidden className={cn(base, "text-fg")} style={styles[id]}>
      Ag
    </span>
  );
}

const MOODS = [
  "bold",
  "elegant",
  "modern",
  "editorial",
  "tech",
  "friendly",
  "warm",
  "retro",
  "playful",
  "luxury",
  "classic",
  "calm",
];

function FontCombinations() {
  const editor = useEditor();
  const kind = useEditorStore((s) => s.doc.design?.kind ?? "custom");
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const [mood, setMood] = useState<string>("for-you");
  const moods = useMemo(() => {
    const present = new Set(FONT_PAIRINGS.flatMap((p) => p.moods));
    return MOODS.filter((m) => present.has(m));
  }, []);
  const list = useMemo(() => {
    if (mood === "all") return [...FONT_PAIRINGS];
    if (mood === "for-you") {
      const forKind = pairingsForKind(kind);
      return forKind.length > 0 ? forKind : FONT_PAIRINGS.slice(0, 12);
    }
    return FONT_PAIRINGS.filter((p) => p.moods.includes(mood));
  }, [mood, kind]);
  const add = (p: FontPairing) => {
    void insertSubtree(
      editor,
      pairingBlock(p.heading, p.headingWeight, p.body, p.bodyWeight, pageInk(editor)),
      {
        label: "Add font combination",
      },
    );
  };
  return (
    <PanelSection title="Font combinations">
      <ChipRow
        label="Font combination mood"
        value={mood}
        onChange={setMood}
        options={[
          { value: "for-you", label: "For this design" },
          ...moods.map((m) => ({ value: m, label: m[0]?.toUpperCase() + m.slice(1) })),
          { value: "all", label: "All" },
        ]}
      />
      <div className="flex flex-col gap-1.5">
        {list.map((p) => (
          <PairingCard key={p.id} pairing={p} disabled={!canEdit} onClick={() => add(p)} />
        ))}
      </div>
    </PanelSection>
  );
}

function PairingCard({
  pairing,
  disabled,
  onClick,
}: {
  pairing: FontPairing;
  disabled: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void Promise.all([
        loadPreviewFont(pairing.heading, pairing.headingWeight),
        loadPreviewFont(pairing.body, pairing.bodyWeight),
      ]).then(() => setLoaded(true));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [pairing]);
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${pairing.heading} with ${pairing.body}`}
      className="group flex w-full cursor-pointer flex-col gap-1 rounded-[12px] bg-surface-2 px-3.5 py-3 text-left transition-[background-color,box-shadow] duration-200 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          "truncate text-[22px] leading-tight text-fg transition-opacity duration-300",
          !loaded && "opacity-70",
        )}
        style={{
          fontFamily: `"${pairing.heading}", ui-serif, Georgia, serif`,
          fontWeight: pairing.headingWeight,
        }}
      >
        {pairing.heading}
      </span>
      <span
        className={cn(
          "truncate text-[13px] text-fg-secondary transition-opacity duration-300",
          !loaded && "opacity-70",
        )}
        style={{
          fontFamily: `"${pairing.body}", ui-sans-serif, system-ui`,
          fontWeight: pairing.bodyWeight,
        }}
      >
        {pairing.body} · {pairing.moods.slice(0, 2).join(", ")}
      </span>
    </button>
  );
}
