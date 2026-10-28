"use client";

import { Callout, CircularProgress, cn, IconButton, SunMark, SunSpinner, Tooltip } from "@desyn/ui";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useEditorStore } from "../../context.tsx";
import type { SlotProps } from "../../shell/extensions.ts";
import { aiLocked } from "../core/gating.ts";
import { type DockMode, modeInfo } from "../core/prompt.ts";
import { isActive, isFinal, phaseLabel, replyText } from "../core/reduce.ts";
import { describeStep, finishedLabel } from "../core/steps.ts";
import type { Turn } from "../session.ts";
import { useAi, useAiSession } from "./hooks.ts";
import { NoticeView, UpgradeCard } from "./notices.tsx";
import { PromptBar } from "./prompt-bar.tsx";
import { AiStyles } from "./styles.tsx";
import { TurnView } from "./turn.tsx";

function CreditMeter() {
  const credits = useAi((s) => s.credits);
  const where = useAi((s) => s.execution.current.where);
  if (!credits || credits.granted === null || credits.granted <= 0) return null;
  const left = Math.max(0, credits.remaining ?? 0);
  return (
    <Tooltip
      content={
        credits.throttled
          ? "Past this month's pool: requests are slowed down, never billed extra."
          : where === "browser"
            ? "Runs with your own keys use no credits."
            : `${credits.used} used this month${credits.reserved ? `, ${credits.reserved} reserved` : ""}`
      }
    >
      <button
        type="button"
        aria-label={`${left} credits left this month`}
        className="inline-flex cursor-default items-center gap-1.5 rounded-full px-1.5 py-1 text-2xs text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircularProgress
          value={left}
          max={credits.granted}
          size={14}
          strokeWidth={2}
          label="Credits left"
        />
        <span className="font-mono">{left}</span>
        <span>left</span>
      </button>
    </Tooltip>
  );
}

const SUGGESTIONS: Record<DockMode, string[]> = {
  "edit-selection": [
    "Make this warmer",
    "Tighten the spacing",
    "Write three headline options",
    "Match the brand",
  ],
  "edit-design": [
    "Make it feel more premium",
    "Improve the hierarchy",
    "Fix alignment and spacing",
    "Add a clear call to action",
  ],
  generate: [
    "A launch poster for a specialty coffee roaster",
    "An Instagram story for a summer sale",
    "A minimal business card for an architect",
  ],
  critique: [
    "What would make this stronger?",
    "Is the text readable everywhere?",
    "Check contrast and hierarchy",
  ],
};

function EmptyState() {
  const session = useAiSession();
  const mode = useAi((s) => s.prompt.mode);
  const locked = useAi((s) => aiLocked(s.account));
  if (locked) {
    return (
      <div className="px-4 py-4">
        <UpgradeCard message="Design, edit and critique with the AI is part of Pro." />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
      <SunMark size={28} />
      <h2 className="mt-3 font-serif text-[26px] leading-tight text-fg">
        what shall we <em className="text-accent">make</em>?
      </h2>
      <p className="mt-1.5 max-w-sm text-xs text-fg-muted">
        {modeInfo(mode).hint}. Type / for image, vector and workflow tools.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {SUGGESTIONS[mode].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              session.setText(s);
              window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
            }}
            className="rounded-full bg-fg/[0.03] px-3 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-accent-wash hover:text-fg"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Conversation() {
  const turns = useAi((s) => s.turns);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const size = JSON.stringify(
    turns.map((t) => [
      t.id,
      t.run?.lastIndex ?? 0,
      t.media?.status,
      t.workflow?.status?.progress.done,
    ]),
  );
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current && size) el.scrollTop = el.scrollHeight;
  }, [size]);
  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
      role="log"
      aria-label="Conversation with the AI"
      aria-live="off"
    >
      {turns.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-6">
          {turns.map((t) => (
            <div key={t.id} className="dsn-ai-enter">
              <TurnView turn={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Panel() {
  const session = useAiSession();
  const editor = session.editor;
  const throttled = useAi((s) => s.credits?.throttled ?? false);
  const hasTurns = useAi((s) => s.turns.length > 0);
  return (
    <section
      aria-label="AI assistant"
      className="dsn-ai-enter mb-2 flex max-h-[min(62vh,640px)] min-h-[280px] flex-col overflow-hidden rounded-[20px] border border-line-subtle bg-surface-1/[0.94] shadow-dialog backdrop-blur-[24px] backdrop-saturate-[1.2]"
    >
      <header className="flex items-center gap-2 border-b border-line-subtle py-2 pr-2 pl-4">
        <SunMark size={16} />
        <h2 className="font-serif text-[19px] leading-none text-fg">
          ask <em className="text-accent">desyn</em>
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          <CreditMeter />
          {hasTurns ? (
            <IconButton
              label="New conversation"
              size="sm"
              tooltip="New conversation"
              onClick={() => session.clear()}
            >
              <MessageSquarePlus />
            </IconButton>
          ) : null}
          <IconButton
            label="Collapse"
            size="sm"
            tooltip="Collapse"
            onClick={() => editor.setPanels({ aiDock: "bar" })}
          >
            <ChevronDown />
          </IconButton>
          <IconButton
            label="Close AI"
            size="sm"
            tooltip="Close"
            shortcut="mod+j"
            onClick={() => editor.setPanels({ aiDock: "closed" })}
          >
            <X />
          </IconButton>
        </div>
      </header>
      {throttled ? (
        <Callout
          tone="warning"
          className="mx-4 mt-3 text-xs"
          title="You've used this month's credits"
        >
          The AI keeps working, a little slower, until your credits renew. Nothing is billed extra.
        </Callout>
      ) : null}
      <Conversation />
    </section>
  );
}

/** One line above the collapsed bar: what the latest turn is doing, click to open the conversation. */
function LatestLine({ turn }: { turn: Turn }) {
  const session = useAiSession();
  const run = turn.run;
  const active = (run && isActive(run)) || turn.media?.status === "running";
  const lastTool = run ? [...run.items].reverse().find((i) => i.kind === "tool") : undefined;
  const detail = run
    ? isFinal(run)
      ? replyText(run).split("\n")[0] || run.summary || phaseLabel(run)
      : run.phase === "needs-input"
        ? (run.question?.question ?? "Waiting for your answer")
        : lastTool && lastTool.kind === "tool"
          ? finishedLabel(lastTool.tool, lastTool.input, lastTool.status, lastTool.summary) ||
            describeStep(lastTool.tool, lastTool.input).running
          : phaseLabel(run)
    : turn.media?.status === "running"
      ? "Working on it"
      : (turn.error ?? (turn.media?.status === "done" ? "Done" : ""));
  const failed =
    (run && run.phase === "failed") || turn.media?.status === "failed" || (!run && !!turn.error);
  return (
    <button
      type="button"
      onClick={() => session.editor.setPanels({ aiDock: "expanded" })}
      className="dsn-ai-enter mx-auto mb-2 flex max-w-full items-center gap-2 rounded-full border border-line-subtle bg-surface-1/90 py-1.5 pr-3 pl-2 text-xs text-fg-secondary shadow-popover backdrop-blur-[20px] transition-colors hover:text-fg"
    >
      {active ? (
        <SunSpinner size={14} label="" aria-hidden />
      ) : failed ? (
        <CircleAlert className="size-3.5 text-danger" aria-hidden />
      ) : run?.phase === "needs-input" ? (
        <span className="mx-1 size-2 animate-sun-pulse rounded-full bg-accent" aria-hidden />
      ) : (
        <CircleCheck className="size-3.5 text-success" aria-hidden />
      )}
      <span className={cn("max-w-[420px] truncate", active && "dsn-ai-shimmer-text")}>
        {detail}
      </span>
      <ChevronUp className="size-3.5 text-fg-muted" aria-hidden />
    </button>
  );
}

/** The `ai.dock` slot: prompt bar anchored bottom-center that expands into the conversation and run log. */
export function AiDock(_props: SlotProps) {
  const dock = useEditorStore((s) => s.panels.aiDock);
  const compact = useEditorStore((s) => s.compact);
  const notice = useAi((s) => s.notice);
  const latest = useAi((s) => s.turns[s.turns.length - 1]);

  if (dock === "closed") return <AiStyles />;
  return (
    <div className={cn("pointer-events-auto w-full", compact ? "max-w-full" : "max-w-[680px]")}>
      <AiStyles />
      {dock === "expanded" ? <Panel /> : latest ? <LatestLine turn={latest} /> : null}
      {notice ? (
        <div className="dsn-ai-enter mb-2">
          <NoticeView notice={notice} />
        </div>
      ) : null}
      <PromptBar autoFocus={dock === "expanded"} />
    </div>
  );
}
