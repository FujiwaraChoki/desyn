"use client";

import { Button, cn, ProBadge, SunSpinner, Textarea } from "@desyn/ui";
import {
  Copy,
  FileSpreadsheet,
  ImagePlus,
  Languages,
  LayoutGrid,
  Megaphone,
  MessageSquare,
  PenTool,
  Stamp,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useEditor, useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import type { RunInfo, WorkflowType } from "../backend/types.ts";
import { type AiAction, gate } from "../core/gating.ts";
import { creditsFor } from "../core/prompt.ts";
import { useAi, useAiSession } from "./hooks.ts";
import { AiActionButton, AiSection } from "./parts.tsx";

type Output = "illustration" | "icon" | "sticker" | "pattern" | "photo";

const OUTPUTS: { value: Output; label: string; hint: string }[] = [
  { value: "illustration", label: "Illustration", hint: "Editable vector scene" },
  { value: "icon", label: "Icon", hint: "Single-color vector icon" },
  { value: "sticker", label: "Sticker", hint: "Bold vector badge with outline" },
  { value: "pattern", label: "Pattern", hint: "Seamless vector pattern" },
  { value: "photo", label: "Image", hint: "Generated bitmap image" },
];

const IDEAS: Record<Output, string[]> = {
  illustration: [
    "a cosy reading nook with a cat",
    "mountains at sunrise, flat shapes",
    "hands holding a coffee cup",
  ],
  icon: ["a paper plane", "a calendar with a heart", "a leaf inside a circle"],
  sticker: ["“fresh drop” with sparkles", "a smiling sun", "a retro cassette"],
  pattern: ["terrazzo in warm tones", "tiny citrus slices", "wavy lines"],
  photo: [
    "a ceramic vase on linen, soft window light",
    "an empty sunlit street in Lisbon",
    "fresh croissants on marble",
  ],
};

/** Elements AI: generate illustrations, icons, stickers, patterns or images and place them on the page. */
function Generator() {
  const session = useAiSession();
  const [output, setOutput] = useState<Output>("illustration");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const action: AiAction = output === "photo" ? "image" : "svg";
  const generate = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    try {
      if (output === "photo") await session.generateImage(text, { style: "photo" });
      else
        await session.generateSvg(text, {
          kind: output === "sticker" ? "badge" : output,
          ...(output === "icon" ? { strokeOnly: true } : {}),
        });
      setPrompt("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AiSection
      title="Generate"
      description="Made on the fly and placed on the page as a layer you can edit."
    >
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">What to make</legend>
        {OUTPUTS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={output === o.value}
            onClick={() => setOutput(o.value)}
            className={cn(
              "h-7 rounded-full px-2.5 text-xs transition-colors",
              output === o.value
                ? "bg-accent-tint text-accent-text"
                : "bg-fg/[0.04] text-fg-secondary hover:bg-fg/[0.07] hover:text-fg",
            )}
          >
            {o.label}
          </button>
        ))}
      </fieldset>
      <p className="mt-2 text-2xs text-fg-muted">{OUTPUTS.find((o) => o.value === output)?.hint}</p>
      <Textarea
        className="mt-2"
        minRows={3}
        autoResize
        aria-label="Describe it"
        placeholder={`Describe the ${OUTPUTS.find((o) => o.value === output)?.label.toLowerCase()}…`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
        }}
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {IDEAS[output].map((idea) => (
          <button
            key={idea}
            type="button"
            onClick={() => setPrompt(idea)}
            className="rounded-full bg-fg/[0.04] px-2 py-1 text-2xs text-fg-muted transition-colors hover:bg-fg/[0.07] hover:text-fg"
          >
            {idea}
          </button>
        ))}
      </div>
      <AiActionButton
        action={action}
        credits={creditsFor(output === "photo" ? "ai.image" : "ai.svg")}
        variant="primary"
        className="mt-3 w-full"
        loading={busy}
        disabled={!prompt.trim() || !canEdit}
        onClick={() => void generate()}
      >
        {output === "photo" ? (
          <ImagePlus className="size-4" aria-hidden />
        ) : (
          <PenTool className="size-4" aria-hidden />
        )}
        Generate
      </AiActionButton>
    </AiSection>
  );
}

const WORKFLOWS: { type: WorkflowType; title: string; body: string; icon: ReactNode }[] = [
  {
    type: "campaign",
    title: "Campaign",
    body: "One brief, a coherent set of designs",
    icon: <Megaphone />,
  },
  { type: "variants", title: "Variants", body: "A/B alternatives along one axis", icon: <Copy /> },
  {
    type: "resize",
    title: "Magic resize",
    body: "Every format, reflowed by role",
    icon: <LayoutGrid />,
  },
  {
    type: "localize",
    title: "Localize",
    body: "Translated copies with RTL and fonts",
    icon: <Languages />,
  },
  {
    type: "bulk",
    title: "Bulk create",
    body: "A design for every spreadsheet row",
    icon: <FileSpreadsheet />,
  },
];

function Workflows() {
  const session = useAiSession();
  const account = useAi((s) => s.account);
  const brandKit = useAi((s) => s.brandKit);
  const brandLocked = gate(account, "brand").state === "upgrade";
  return (
    <AiSection
      title="Workflows"
      description="Long-running jobs that create new designs. Progress shows in the AI dock."
    >
      <ul className="grid gap-1.5">
        {WORKFLOWS.map((w) => {
          const locked = gate(account, `workflow.${w.type}`).state === "upgrade";
          return (
            <li key={w.type}>
              <button
                type="button"
                onClick={() => session.openWorkflow(w.type, {})}
                className="group flex w-full items-center gap-3 rounded-card bg-fg/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-accent-wash"
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-fg/5 text-fg-muted transition-colors group-hover:text-accent [&_svg]:size-4"
                  aria-hidden
                >
                  {w.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">{w.title}</span>
                  <span className="block truncate text-2xs text-fg-muted">{w.body}</span>
                </span>
                {locked ? <ProBadge /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="mt-3 w-full justify-between"
        leadingIcon={<Stamp />}
        onClick={() => void session.matchBrand()}
        trailingIcon={brandLocked ? <ProBadge /> : undefined}
      >
        <span className="flex-1 text-left">
          {brandKit ? `Match ${brandKit.name}` : "Match my brand"}
        </span>
      </Button>
    </AiSection>
  );
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  "needs-input": "Needs your answer",
  completed: "Done",
  cancelled: "Stopped",
  failed: "Failed",
  "budget-exceeded": "Budget reached",
  "step-limit": "Step limit",
};

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Recent agent runs on this design (anyone's), reopenable in the dock. */
function RecentRuns() {
  const session = useAiSession();
  const editor = useEditor();
  const designId = useEditorStore((s) => s.designId);
  const turns = useAi((s) => s.turns.length);
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshed when this session adds a turn
  useEffect(() => {
    if (!session.backend) return;
    let alive = true;
    void session.backend
      .listRuns(designId, 12)
      .then((r) => alive && setRuns(r.filter((x) => x.kind === "agent")))
      .catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [session, designId, turns]);
  if (!session.backend) return null;
  return (
    <AiSection title="Recent runs">
      {runs === null ? (
        <div className="flex justify-center py-3">
          <SunSpinner size="sm" label="Loading runs" />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-2xs text-fg-muted">
          Nothing yet. What you ask the AI on this design shows up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {runs.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  session.adoptServerRun(r.id, r.goal ?? "AI run");
                  editor.setPanels({ aiDock: "expanded" });
                }}
                className="w-full rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-fg/5"
              >
                <span className="line-clamp-2 text-xs text-fg-secondary">
                  {r.goal?.split("\n")[0] ?? "AI run"}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-placeholder">
                  <span
                    className={cn(
                      r.status === "failed" && "text-danger",
                      r.status === "running" && "text-accent-text",
                    )}
                  >
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                  · {ago(r.createdAt)}
                  {r.costCredits > 0 ? ` · ${r.costCredits} cr` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </AiSection>
  );
}

/** Rail panel "AI": generator, workflows, brand matching and run history. */
export function AiRailPanel(_props: SlotProps) {
  const session = useAiSession();
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-1 pb-3">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          leadingIcon={<MessageSquare />}
          onClick={() => {
            session.editor.setPanels({ aiDock: "expanded" });
            window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
          }}
        >
          Ask the AI
        </Button>
      </div>
      <Generator />
      <Workflows />
      <RecentRuns />
    </div>
  );
}
