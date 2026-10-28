"use client";

import { getPreset, PAGE_PRESETS, type PagePreset } from "@desyn/schema";
import { Button, cn, Input, Stepper, Switch, Textarea } from "@desyn/ui";
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModalDef, ModalProps } from "../../../shell/extensions.ts";
import { useAi, useAiSession } from "../hooks.ts";
import { FieldLabel, useWorkflowEstimate, WorkflowDialog } from "./common.tsx";

/** Deliverable sets that make sense together (one tap fills the list). */
const PACKS: { id: string; label: string; presets: string[] }[] = [
  {
    id: "social",
    label: "Social launch",
    presets: ["instagram-post", "instagram-story", "facebook-post", "linkedin-post", "x-post"],
  },
  {
    id: "ads",
    label: "Display ads",
    presets: ["ad-medium-rectangle", "ad-leaderboard", "ad-half-page", "facebook-ad"],
  },
  {
    id: "event",
    label: "Event",
    presets: ["instagram-story", "facebook-event-cover", "email-banner", "instagram-post"],
  },
  {
    id: "video",
    label: "Video covers",
    presets: ["youtube-thumbnail", "instagram-reel-cover", "tiktok-video"],
  },
];

const BRIEF_IDEAS = [
  "Spring launch for a specialty coffee roaster: new single-origin from Ethiopia, warm and confident.",
  "Grand opening of a neighbourhood bakery on Saturday, playful, with a 20% opening discount.",
  "Webinar announcement for a B2B analytics product, calm and credible, sign-up call to action.",
];

function CampaignDialog({ props, close }: ModalProps) {
  const session = useAiSession();
  const brandKit = useAi((s) => s.brandKit);
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState(typeof props.brief === "string" ? props.brief : "");
  const [selected, setSelected] = useState<string[]>(PACKS[0]?.presets ?? []);
  const [query, setQuery] = useState("");
  const [useBrand, setUseBrand] = useState(true);
  const [keyVisual, setKeyVisual] = useState(true);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PAGE_PRESETS.filter(
      (p) => !q || p.label.toLowerCase().includes(q) || p.id.includes(q),
    ).slice(0, 60);
  }, [query]);
  const deliverables = selected
    .map((id) => getPreset(id))
    .filter((p): p is PagePreset => !!p)
    .map((p) => ({ kind: p.kind, preset: p.id, name: p.label }));
  const input =
    brief.trim().length >= 5 && deliverables.length > 0
      ? {
          brief: brief.trim(),
          deliverables,
          keyVisual,
          ...(brandKit && useBrand ? { brandKitId: brandKit.id } : {}),
        }
      : null;
  const estimate = useWorkflowEstimate("campaign", input);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(0, 20)));

  const start = async () => {
    if (!input) return;
    setBusy(true);
    const id = await session.startWorkflow(
      "campaign",
      input,
      `Campaign · ${brief.trim().slice(0, 60)}`,
    );
    setBusy(false);
    if (id) close();
  };

  const steps = [{ label: "Brief" }, { label: "Deliverables" }, { label: "Look" }];
  const canNext =
    step === 0 ? brief.trim().length >= 5 : step === 1 ? deliverables.length > 0 : true;

  return (
    <WorkflowDialog
      action="workflow.campaign"
      title={
        <>
          a <em className="text-accent">campaign</em> from one brief
        </>
      }
      description="One concept, palette and voice, built into every format you need."
      close={close}
      estimate={estimate}
      startLabel={step < 2 ? "Next" : `Create ${deliverables.length} designs`}
      canStart={step < 2 ? canNext : !!input}
      onStart={() => (step < 2 ? setStep(step + 1) : void start())}
      busy={busy}
      {...(input ? {} : { estimateHint: "Add a brief and formats to see the cost" })}
    >
      <Stepper steps={steps} current={step} onStepClick={(i) => setStep(i)} className="mb-5" />
      {step === 0 ? (
        <div>
          <FieldLabel htmlFor="campaign-brief">What is the campaign about?</FieldLabel>
          <Textarea
            id="campaign-brief"
            autoFocus
            minRows={4}
            autoResize
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Product, audience, message, tone, offer, dates…"
          />
          <div className="mt-3 flex flex-col gap-1.5">
            {BRIEF_IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setBrief(idea)}
                className="rounded-[8px] bg-fg/[0.04] px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-fg/[0.07] hover:text-fg"
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {step === 1 ? (
        <div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PACKS.map((pack) => (
              <Button
                key={pack.id}
                size="xs"
                variant="outline"
                shape="pill"
                onClick={() => setSelected(pack.presets)}
              >
                {pack.label}
              </Button>
            ))}
          </div>
          <Input
            size="sm"
            leading={<Search />}
            placeholder="Search formats"
            aria-label="Search formats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="mt-2 grid max-h-64 grid-cols-1 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
            {list.map((p) => {
              const on = selected.includes(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(p.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-xs transition-colors",
                      on
                        ? "bg-accent-wash text-fg"
                        : "bg-fg/[0.04] text-fg-secondary hover:bg-fg/[0.07]",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                        on ? "border-transparent bg-accent-solid text-accent-ink" : "border-line",
                      )}
                      aria-hidden
                    >
                      {on ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    <span className="font-mono text-[10px] text-fg-placeholder">
                      {p.width}×{p.height}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-2xs text-fg-muted">{deliverables.length} of 20 formats</p>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="flex flex-col gap-4">
          {brandKit ? (
            <Switch
              checked={useBrand}
              onCheckedChange={setUseBrand}
              label={`Use the brand kit “${brandKit.name}”`}
              description="Colors, fonts, logo and voice come from the kit; the concept fills in the rest."
            />
          ) : (
            <p className="text-xs text-fg-muted">
              No brand kit in this workspace: the concept chooses a palette and fonts that fit the
              brief.
            </p>
          )}
          <Switch
            checked={keyVisual}
            onCheckedChange={setKeyVisual}
            label="Shared key visual"
            description="Generate one hero image used across every format, so the set reads as one campaign."
          />
          <div className="rounded-card bg-fg/[0.02] p-3 text-xs text-fg-secondary">
            <p className="font-serif text-base text-fg">
              “{brief.trim().slice(0, 140)}
              {brief.trim().length > 140 ? "…" : ""}”
            </p>
            <p className="mt-1.5 text-fg-muted">
              {deliverables.length} designs ·{" "}
              {deliverables
                .map((d) => d.name)
                .slice(0, 4)
                .join(", ")}
              {deliverables.length > 4 ? ` and ${deliverables.length - 4} more` : ""}
            </p>
          </div>
        </div>
      ) : null}
    </WorkflowDialog>
  );
}

export const campaignModal: ModalDef = { id: "ai.workflow.campaign", component: CampaignDialog };
