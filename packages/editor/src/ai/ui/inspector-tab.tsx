"use client";

import type { OutpaintDirection } from "@desyn/ai";
import { Button, cn, IconButton, SegmentedControl, Select, Slider, Textarea } from "@desyn/ui";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brush,
  Building2,
  Coffee,
  Eraser,
  Expand,
  Frame,
  Laptop,
  Maximize2,
  MessageSquare,
  MoveHorizontal,
  MoveVertical,
  PenLine,
  PenTool,
  ScanEye,
  ShoppingBag,
  Smartphone,
  SpellCheck,
  Store,
  Type,
  UnfoldVertical,
  ZoomIn,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { ASPECTS, creditsFor, expandTarget, LANGUAGES, TONES } from "../core/prompt.ts";
import { selectedImages } from "../media.ts";
import { useAiSession } from "./hooks.ts";
import { AiActionButton, AiSection, useLocked } from "./parts.tsx";

const DIRECTION_GRID: { id: OutpaintDirection | null; icon: ReactNode; label: string }[] = [
  { id: null, icon: null, label: "" },
  { id: "up", icon: <ArrowUp />, label: "Grow upwards" },
  { id: null, icon: null, label: "" },
  { id: "left", icon: <ArrowLeft />, label: "Grow to the left" },
  { id: "all", icon: <Maximize2 />, label: "Grow on all sides" },
  { id: "right", icon: <ArrowRight />, label: "Grow to the right" },
  { id: "horizontal", icon: <MoveHorizontal />, label: "Grow left and right" },
  { id: "down", icon: <ArrowDown />, label: "Grow downwards" },
  { id: "vertical", icon: <MoveVertical />, label: "Grow up and down" },
];

export const MOCKUP_SCENES: { id: string; label: string; scene: string; icon: ReactNode }[] = [
  {
    id: "gallery",
    label: "Gallery wall",
    scene: "a framed print on a sunlit gallery wall, soft shadows",
    icon: <Frame />,
  },
  {
    id: "phone",
    label: "Phone in hand",
    scene: "a smartphone held in hand at a warm café, shallow depth of field",
    icon: <Smartphone />,
  },
  {
    id: "laptop",
    label: "Laptop desk",
    scene: "a laptop screen on an oak desk by a window, morning light",
    icon: <Laptop />,
  },
  {
    id: "billboard",
    label: "Billboard",
    scene: "a large city billboard at golden hour",
    icon: <Building2 />,
  },
  {
    id: "tote",
    label: "Tote bag",
    scene: "printed on a natural canvas tote bag on linen",
    icon: <ShoppingBag />,
  },
  {
    id: "cafe",
    label: "Café table",
    scene: "a printed card on a marble café table next to a cup of coffee",
    icon: <Coffee />,
  },
  {
    id: "store",
    label: "Shop window",
    scene: "a poster in a boutique shop window, street reflections",
    icon: <Store />,
  },
];

function useImageUrl(refId: string | null): string | null {
  const editor = useEditor();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const ref = refId ? editor.design?.assets[refId] : undefined;
    if (!ref) {
      setUrl(null);
      return;
    }
    void editor.assets.urlFor(ref).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [editor, refId]);
  return url;
}

/** Preview of an expansion: the source image inside the new frame, new areas hatched in sun. */
function ExpandPreview({
  url,
  width,
  height,
  ratio,
  direction,
}: {
  url: string | null;
  width: number;
  height: number;
  ratio: number;
  direction: OutpaintDirection;
}) {
  const t = expandTarget(width, height, ratio, direction);
  const max = { w: 248, h: 150 };
  const s = Math.min(max.w / t.width, max.h / t.height);
  return (
    <div className="grid h-[164px] place-items-center rounded-card bg-canvas">
      <div
        className="relative overflow-hidden rounded-[4px] shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.55)] transition-all duration-500 ease-out"
        style={{
          width: t.width * s,
          height: t.height * s,
          backgroundImage:
            "repeating-linear-gradient(135deg, rgb(var(--accent-rgb) / 0.22) 0 6px, rgb(var(--accent-rgb) / 0.06) 6px 12px)",
        }}
        aria-label={`New size ${t.width} by ${t.height} pixels`}
        role="img"
      >
        <div
          className="absolute bg-fg/10 transition-all duration-500 ease-out"
          style={{
            left: t.grow.left * s,
            top: t.grow.top * s,
            width: width * s,
            height: height * s,
          }}
        >
          {url ? <img src={url} alt="" className="size-full object-fill" /> : null}
        </div>
      </div>
      <span className="sr-only">
        The image grows from {width}×{height} to {t.width}×{t.height}.
      </span>
    </div>
  );
}

function ImageActions() {
  const session = useAiSession();
  const editor = useEditor();
  useEditorStore((s) => s.selection);
  useEditorStore((s) => s.doc.design);
  const target = selectedImages(editor)[0];
  const url = useImageUrl(target?.refId ?? null);
  const [factor, setFactor] = useState<"2" | "4">("2");
  const [aspect, setAspect] = useState("16:9");
  const [direction, setDirection] = useState<OutpaintDirection>("all");
  const [expandPrompt, setExpandPrompt] = useState("");
  const [scene, setScene] = useState(MOCKUP_SCENES[0]?.scene ?? "");
  const [colors, setColors] = useState(8);
  const [detail, setDetail] = useState<"low" | "medium" | "high">("medium");
  const lockedExpand = useLocked("outpaint");
  if (!target) return null;
  const w = target.ref.width ?? Math.round(target.node.width);
  const h = target.ref.height ?? Math.round(target.node.height);
  const ratio = ASPECTS.find((a) => a.id === aspect)?.ratio ?? 16 / 9;
  const t = expandTarget(w, h, ratio, direction);
  const noChange = t.width === w && t.height === h;
  return (
    <>
      <AiSection id="ai-section-image" title="Image">
        <div className="grid gap-2">
          <AiActionButton
            action="removeBackground"
            credits={creditsFor("ai.removeBackground")}
            variant="secondary"
            onClick={() => void session.removeBackground()}
          >
            <Eraser className="size-4" aria-hidden />
            Remove background
          </AiActionButton>
          <div className="flex items-center gap-2">
            <SegmentedControl
              size="sm"
              aria-label="Upscale factor"
              value={factor}
              onValueChange={setFactor}
              options={[
                { value: "2", label: "2×" },
                { value: "4", label: "4×" },
              ]}
            />
            <AiActionButton
              action="upscale"
              credits={creditsFor("ai.upscale")}
              variant="secondary"
              className="flex-1"
              onClick={() => void session.upscale(factor === "4" ? 4 : 2)}
            >
              <ZoomIn className="size-4" aria-hidden />
              Upscale
            </AiActionButton>
          </div>
          <AiActionButton
            action="inpaint"
            credits={creditsFor("ai.inpaint")}
            variant="secondary"
            onClick={() =>
              session.check("inpaint") && editor.openModal("ai.inpaint", { nodeId: target.node.id })
            }
          >
            <Brush className="size-4" aria-hidden />
            Repaint an area…
          </AiActionButton>
        </div>
      </AiSection>
      <AiSection
        id="ai-section-expand"
        title="Expand"
        description="Generate what lies beyond the edges. The original pixels stay where they are."
        locked={lockedExpand}
      >
        <ExpandPreview url={url} width={w} height={h} ratio={ratio} direction={direction} />
        <fieldset className="m-0 min-w-0 border-0 p-0 mt-3 flex flex-wrap gap-1">
          <legend className="sr-only">New shape</legend>
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={aspect === a.id}
              onClick={() => setAspect(a.id)}
              className={cn(
                "h-7 rounded-full px-2.5 font-mono text-2xs transition-colors",
                aspect === a.id
                  ? "bg-accent-tint text-accent-text"
                  : "bg-fg/[0.04] text-fg-muted hover:text-fg",
              )}
              title={a.label}
            >
              {a.id}
            </button>
          ))}
        </fieldset>
        <div className="mt-3 flex items-start gap-3">
          <fieldset className="m-0 min-w-0 border-0 p-0 grid grid-cols-3 gap-1">
            <legend className="sr-only">Direction</legend>
            {DIRECTION_GRID.map((d, i) =>
              d.id ? (
                <IconButton
                  key={d.id}
                  label={d.label}
                  size="sm"
                  variant="secondary"
                  aria-pressed={direction === d.id}
                  onClick={() => setDirection(d.id as OutpaintDirection)}
                >
                  {d.icon}
                </IconButton>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 3x3 layout spacers
                <span key={i} className="size-7" />
              ),
            )}
          </fieldset>
          <div className="min-w-0 flex-1 text-2xs leading-relaxed text-fg-muted">
            <p className="font-mono text-fg-secondary">
              {w}×{h} → {t.width}×{t.height}
            </p>
            <p className="mt-1">
              {noChange
                ? "Already this shape. Pick another ratio or direction."
                : "Hatched areas are generated."}
            </p>
          </div>
        </div>
        <Textarea
          className="mt-3"
          minRows={2}
          autoResize
          placeholder="Optional: what should appear there…"
          aria-label="What should appear in the new area"
          value={expandPrompt}
          onChange={(e) => setExpandPrompt(e.target.value)}
        />
        <AiActionButton
          action="outpaint"
          credits={creditsFor("ai.outpaint")}
          variant="primary"
          className="mt-2 w-full"
          disabled={noChange}
          onClick={() => void session.expand({ ratio, direction, prompt: expandPrompt })}
        >
          <Expand className="size-4" aria-hidden />
          Expand image
        </AiActionButton>
      </AiSection>
      <AiSection
        id="ai-section-trace"
        title="Trace to vector"
        description="Turns the image into an editable vector layer above it."
      >
        <div className="flex items-center gap-3">
          <span className="w-14 text-2xs text-fg-muted">Colors</span>
          <Slider
            aria-label="Colors"
            min={2}
            max={16}
            step={1}
            value={[colors]}
            onValueChange={(v) => setColors(v[0] ?? 8)}
            className="flex-1"
          />
          <span className="w-6 text-right font-mono text-2xs text-fg-secondary">{colors}</span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="w-14 text-2xs text-fg-muted">Detail</span>
          <SegmentedControl
            size="sm"
            fullWidth
            className="flex-1"
            aria-label="Detail"
            value={detail}
            onValueChange={setDetail}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </div>
        <AiActionButton
          action="trace"
          credits={creditsFor("ai.svg")}
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => void session.trace({ colors, detail })}
        >
          <PenTool className="size-4" aria-hidden />
          Trace to vector
        </AiActionButton>
      </AiSection>
      <MockupSection scene={scene} setScene={setScene} />
    </>
  );
}

function MockupSection({ scene, setScene }: { scene: string; setScene: (s: string) => void }) {
  const session = useAiSession();
  const locked = useLocked("mockup");
  const picked = MOCKUP_SCENES.find((m) => m.scene === scene)?.id ?? null;
  return (
    <AiSection
      id="ai-section-mockup"
      title="Mockup"
      description="Stages the selected image, or this page, in a photographed scene on a new page."
      locked={locked}
    >
      <fieldset className="m-0 min-w-0 border-0 p-0 grid grid-cols-2 gap-1.5">
        <legend className="sr-only">Scene</legend>
        {MOCKUP_SCENES.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={picked === m.id}
            onClick={() => setScene(m.scene)}
            className={cn(
              "flex items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-xs transition-colors [&_svg]:size-3.5",
              picked === m.id
                ? "bg-accent-wash text-fg"
                : "bg-fg/[0.04] text-fg-secondary hover:bg-fg/[0.07] hover:text-fg",
            )}
          >
            <span className={picked === m.id ? "text-accent" : "text-fg-muted"} aria-hidden>
              {m.icon}
            </span>
            {m.label}
          </button>
        ))}
      </fieldset>
      <Textarea
        className="mt-2"
        minRows={2}
        autoResize
        aria-label="Scene description"
        value={scene}
        onChange={(e) => setScene(e.target.value)}
      />
      <AiActionButton
        action="mockup"
        credits={creditsFor("ai.mockup")}
        variant="secondary"
        className="mt-2 w-full"
        disabled={!scene.trim()}
        onClick={() => void session.mockup(scene.trim())}
      >
        <ScanEye className="size-4" aria-hidden />
        Make mockup
      </AiActionButton>
    </AiSection>
  );
}

function TextActions() {
  const session = useAiSession();
  const [language, setLanguage] = useState("de");
  const lockedCopy = useLocked("copy");
  const lockedTranslate = useLocked("translate");
  const languageLabel = LANGUAGES.find((l) => l.code === language)?.label ?? language;
  const options = useMemo(
    () => LANGUAGES.map((l) => ({ value: l.code, label: l.rtl ? `${l.label} (RTL)` : l.label })),
    [],
  );
  return (
    <AiSection id="ai-section-text" title="Text" locked={lockedCopy}>
      <div className="grid grid-cols-2 gap-1.5">
        <AiActionButton
          action="copy"
          size="sm"
          variant="secondary"
          onClick={() => void session.textAction({ kind: "rewrite" })}
        >
          <PenLine className="size-3.5" aria-hidden />
          Rewrite
        </AiActionButton>
        <AiActionButton
          action="copy"
          size="sm"
          variant="secondary"
          onClick={() => void session.textAction({ kind: "shorten" })}
        >
          <Type className="size-3.5" aria-hidden />
          Shorten
        </AiActionButton>
        <AiActionButton
          action="copy"
          size="sm"
          variant="secondary"
          onClick={() => void session.textAction({ kind: "lengthen" })}
        >
          <UnfoldVertical className="size-3.5" aria-hidden />
          Expand
        </AiActionButton>
        <AiActionButton
          action="copy"
          size="sm"
          variant="secondary"
          onClick={() => void session.textAction({ kind: "fix" })}
        >
          <SpellCheck className="size-3.5" aria-hidden />
          Fix spelling
        </AiActionButton>
      </div>
      <p className="mt-3 mb-1.5 text-2xs text-fg-muted">Tone</p>
      <div className="flex flex-wrap gap-1">
        {TONES.map((tone) => (
          <button
            key={tone}
            type="button"
            onClick={() => void session.textAction({ kind: "tone", tone })}
            className="h-7 rounded-full bg-fg/[0.04] px-2.5 text-xs text-fg-secondary transition-colors hover:bg-accent-wash hover:text-fg"
          >
            {tone}
          </button>
        ))}
      </div>
      <p className="mt-3 mb-1.5 flex items-center gap-2 text-2xs text-fg-muted">
        Translate
        {lockedTranslate && !lockedCopy ? <span className="text-accent-text">Pro</span> : null}
      </p>
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="Language"
          size="sm"
          className="min-w-0 flex-1"
          value={language}
          onValueChange={setLanguage}
          options={options}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void session.textAction({ kind: "translate", language: languageLabel })}
        >
          Translate
        </Button>
      </div>
    </AiSection>
  );
}

/** Inspector tab "AI": generative actions for the selected images and text layers. */
export function AiInspectorTab(_props: SlotProps) {
  const session = useAiSession();
  const editor = useEditor();
  const selection = useEditorStore((s) => s.selection);
  const design = useEditorStore((s) => s.doc.design);
  const hasImage = selectedImages(editor).length > 0;
  const hasText = !!design && selection.some((id) => design.nodes[id]?.type === "text");

  useEffect(() => {
    const onSection = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      if (!section) return;
      requestAnimationFrame(() =>
        document
          .getElementById(`ai-section-${section}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    };
    window.addEventListener("desyn:ai-inspector", onSection);
    return () => window.removeEventListener("desyn:ai-inspector", onSection);
  }, []);

  return (
    <div className="flex flex-col">
      {hasImage ? <ImageActions /> : null}
      {hasText ? <TextActions /> : null}
      {!hasImage && !hasText ? (
        <div className="px-4 py-6 text-center">
          <p className="font-serif text-lg text-fg">
            ask about <em className="text-accent">this</em>
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Select an image for background removal, expand, upscale, mockups and tracing, or text
            for rewriting and translation.
          </p>
        </div>
      ) : null}
      <div className="px-4 py-4">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          leadingIcon={<MessageSquare />}
          onClick={() => {
            session.setMode(selection.length > 0 ? "edit-selection" : "edit-design");
            editor.setPanels({
              aiDock:
                editor.getState().panels.aiDock === "closed"
                  ? "bar"
                  : editor.getState().panels.aiDock,
            });
            window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
          }}
        >
          Edit with AI…
        </Button>
      </div>
    </div>
  );
}
