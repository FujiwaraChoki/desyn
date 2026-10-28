"use client";

import {
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Progress,
  SunMark,
  SunSpinner,
  VisuallyHidden,
} from "@desyn/ui";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Coins,
  Laptop,
  Redo2,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useEditor } from "../../context.tsx";
import { formatCredits } from "../core/prompt.ts";
import {
  isActive,
  isFinal,
  type LogItem,
  phaseLabel,
  type RunView,
  replyText,
  thinkingSummary,
} from "../core/reduce.ts";
import { describeStep, finishedLabel } from "../core/steps.ts";
import type { Turn } from "../session.ts";
import { useAiSession } from "./hooks.ts";
import { COMMAND_ICONS, STEP_ICONS } from "./icons.tsx";
import { RichText } from "./rich-text.tsx";

function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** The user's side of a turn: prompt text, command chip and attached images. */
function UserMessage({ turn }: { turn: Turn }) {
  const Icon = turn.command ? COMMAND_ICONS[turn.command] : undefined;
  return (
    <div className="flex flex-col items-end gap-1.5 pl-10">
      {turn.attachments.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {turn.attachments.map((a) => (
            <img
              key={a.id}
              src={a.previewUrl}
              alt={a.name}
              className="size-12 rounded-[8px] border border-line-subtle object-cover"
            />
          ))}
        </div>
      ) : null}
      <div className="max-w-full rounded-[14px] rounded-br-[4px] bg-fg/7 px-3 py-2 text-sm leading-relaxed text-fg">
        {Icon ? (
          <span className="mr-1.5 inline-flex translate-y-[2px] text-accent-text">
            <Icon className="size-3.5" aria-hidden />
          </span>
        ) : null}
        <span className="whitespace-pre-wrap break-words">{turn.title}</span>
      </div>
    </div>
  );
}

function StepRow({ item }: { item: Extract<LogItem, { kind: "tool" }> }) {
  const d = describeStep(item.tool, item.input);
  const Icon = STEP_ICONS[d.icon];
  const label = finishedLabel(item.tool, item.input, item.status, item.summary);
  return (
    <li className="group flex min-h-7 items-start gap-2.5 py-0.5">
      <span
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-300",
          item.status === "running" && "bg-accent-tint text-accent",
          item.status === "ok" && "bg-fg/6 text-fg-muted",
          item.status === "failed" && "bg-danger/12 text-danger",
        )}
        aria-hidden
      >
        <Icon
          className={cn("size-3", item.status === "running" && "animate-sun-pulse")}
          strokeWidth={1.75}
        />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 pt-[1px] text-[13px] leading-[1.35rem]",
          item.status === "running" ? "dsn-ai-shimmer-text text-fg" : "text-fg-secondary",
          item.status === "failed" && "text-danger",
        )}
      >
        {label}
      </span>
      {item.ms !== null && item.status !== "running" ? (
        <span className="pt-[3px] font-mono text-2xs text-fg-placeholder opacity-0 transition-opacity group-hover:opacity-100">
          {seconds(item.ms)}
        </span>
      ) : null}
    </li>
  );
}

function ThinkingRow({
  item,
  live,
}: {
  item: Extract<LogItem, { kind: "thinking" }>;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thinking = live && item.endedAt === null;
  const ms = item.endedAt !== null ? Math.max(0, item.endedAt - item.startedAt) : 0;
  // Sub-second thoughts (or replayed logs with one timestamp) read better without a duration.
  const took = ms >= 1000 ? seconds(ms) : null;
  return (
    <li className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 rounded-[6px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-fg-muted" aria-hidden>
          <ChevronRight
            className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")}
          />
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-[1.35rem] text-fg-muted">
          <span className={cn("text-fg-secondary", thinking && "dsn-ai-shimmer-text")}>
            {thinking ? "Thinking" : took ? `Thought for ${took}` : "Thought it through"}
          </span>
          {!open ? <span className="ml-1.5 italic">{thinkingSummary(item.text)}</span> : null}
        </span>
      </button>
      {open ? (
        <p className="mt-1 ml-7.5 max-h-48 overflow-y-auto border-l border-line-subtle pl-3 text-xs leading-relaxed whitespace-pre-wrap text-fg-muted italic">
          {item.text.trim()}
        </p>
      ) : null}
    </li>
  );
}

function PreviewGrid({ items }: { items: Extract<LogItem, { kind: "preview" }>[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const current = items.find((i) => i.id === open);
  return (
    <>
      <div
        className={cn(
          "grid gap-2",
          items.length > 1 ? "grid-cols-2" : "w-fit max-w-full grid-cols-1",
        )}
      >
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpen(p.id)}
            className="group relative overflow-hidden rounded-card border border-line-subtle bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Open preview"
          >
            <img
              src={p.url}
              alt="Preview of the design"
              className="max-h-56 w-auto max-w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.02]"
            />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent px-2 pt-6 pb-1.5 text-left text-2xs text-white/85 opacity-0 transition-opacity group-hover:opacity-100">
              What the AI saw
            </span>
          </button>
        ))}
      </div>
      <Dialog open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent size="xl" className="overflow-hidden p-0">
          <VisuallyHidden>
            <DialogTitle>Preview</DialogTitle>
          </VisuallyHidden>
          {current ? (
            <img
              src={current.url}
              alt="Preview of the design"
              className="max-h-[80vh] w-full bg-canvas object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function QuestionCard({
  turn,
  item,
}: {
  turn: Turn;
  item: Extract<LogItem, { kind: "question" }>;
}) {
  const session = useAiSession();
  const [text, setText] = useState("");
  const waiting = item.answer === null && turn.run?.phase === "needs-input";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) void session.answer(turn.id, text);
  };
  return (
    <div
      className={cn(
        "rounded-card p-3 transition-colors",
        waiting ? "bg-accent-wash" : "bg-fg/[0.02]",
      )}
    >
      <p className="font-serif text-[17px] leading-snug text-fg">{item.question}</p>
      {item.answer !== null ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <Check className="size-3.5 text-success" aria-hidden />
          You answered <span className="text-fg-secondary">“{item.answer}”</span>
        </p>
      ) : waiting ? (
        <>
          {item.options.length > 0 ? (
            <fieldset className="m-0 mt-2.5 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
              <legend className="sr-only">Answers</legend>
              {item.options.map((o) => (
                <Button
                  key={o}
                  size="sm"
                  shape="pill"
                  variant="secondary"
                  onClick={() => void session.answer(turn.id, o)}
                >
                  {o}
                </Button>
              ))}
            </fieldset>
          ) : null}
          <form onSubmit={submit} className="mt-2.5 flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={item.options.length ? "Or answer in your own words…" : "Your answer…"}
              aria-label="Your answer"
              className="h-8 min-w-0 flex-1 rounded-control border border-line-subtle bg-surface-2 px-2.5 text-sm text-fg outline-none placeholder:text-fg-placeholder focus:border-transparent focus:ring-2 focus:ring-ring"
            />
            <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>
              Reply
            </Button>
          </form>
        </>
      ) : (
        <p className="mt-2 text-xs text-fg-muted">The run ended before an answer.</p>
      )}
    </div>
  );
}

function PlanList({ run }: { run: RunView }) {
  if (run.plan.length === 0) return null;
  return (
    <ol className="space-y-1 rounded-card bg-fg/[0.02] px-3 py-2.5" aria-label="Plan">
      {run.plan.map((step) => {
        const done = step.status === "done" || step.status === "completed";
        const active =
          step.status === "running" || step.status === "in-progress" || step.status === "active";
        return (
          <li key={step.id} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border",
                done && "border-transparent bg-accent-solid text-accent-ink",
                active && "border-accent",
                !done && !active && "border-line",
              )}
              aria-hidden
            >
              {done ? <Check className="size-2.5" strokeWidth={3} /> : null}
              {active ? (
                <span className="size-1.5 animate-sun-pulse rounded-full bg-accent" />
              ) : null}
            </span>
            <span
              className={cn(
                done ? "text-fg-muted line-through decoration-fg/20" : "text-fg-secondary",
                active && "text-fg",
              )}
            >
              {step.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Groups consecutive log items so previews sit together and steps form one list. */
function groupItems(
  items: LogItem[],
): { key: string; items: LogItem[]; kind: "steps" | "previews" | LogItem["kind"] }[] {
  const out: { key: string; items: LogItem[]; kind: "steps" | "previews" | LogItem["kind"] }[] = [];
  for (const item of items) {
    const kind =
      item.kind === "tool" || item.kind === "thinking" || item.kind === "workflow"
        ? "steps"
        : item.kind === "preview"
          ? "previews"
          : item.kind;
    const last = out[out.length - 1];
    if (last && last.kind === kind && (kind === "steps" || kind === "previews"))
      last.items.push(item);
    else out.push({ key: item.id, items: [item], kind });
  }
  return out;
}

function RunStatus({ turn, run }: { turn: Turn; run: RunView }) {
  const active = isActive(run);
  const final = isFinal(run);
  const ok = run.phase === "completed";
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
      {active ? (
        <SunSpinner size={14} label="" aria-hidden />
      ) : ok ? (
        <CircleCheck className="size-3.5 text-success" aria-hidden />
      ) : run.phase === "needs-input" ? (
        <span className="size-2 animate-sun-pulse rounded-full bg-accent" aria-hidden />
      ) : final ? (
        <CircleAlert
          className={cn("size-3.5", run.phase === "failed" ? "text-danger" : "text-accent-text")}
          aria-hidden
        />
      ) : null}
      <span className={cn(active && "dsn-ai-shimmer-text text-fg-secondary")}>
        {phaseLabel(run)}
      </span>
      {run.steps > 0 ? (
        <span className="text-fg-placeholder">
          · {run.steps} step{run.steps === 1 ? "" : "s"}
        </span>
      ) : null}
      {turn.execution.where === "browser" ? (
        <Badge size="sm" tone="outline" className="ml-auto gap-1">
          <Laptop aria-hidden />
          this browser
        </Badge>
      ) : run.credits.used > 0 ? (
        <span className="ml-auto inline-flex items-center gap-1 text-fg-placeholder">
          <Coins className="size-3" aria-hidden />
          {formatCredits(run.credits.used)}
        </span>
      ) : null}
    </div>
  );
}

function TurnActions({ turn }: { turn: Turn }) {
  const session = useAiSession();
  const editor = useEditor();
  const run = turn.run;
  const active =
    (run && isActive(run)) ||
    turn.media?.status === "running" ||
    (turn.workflow?.status
      ? !["completed", "failed", "cancelled"].includes(turn.workflow.status.status)
      : !!turn.workflow);
  const canUndo = turn.undo === "available" && editor.canEdit;
  const canRedo = turn.undo === "undone" && session.canRedo(turn.id);
  const canRetry = turn.kind === "agent" && run && isFinal(run) && run.phase !== "completed";
  // Running turns are stopped from the prompt bar (one stop button for everything in flight).
  if (active || (!canUndo && !canRedo && !canRetry)) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canUndo ? (
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={<Undo2 />}
          onClick={() => void session.undo(turn.id)}
        >
          Undo {turn.kind === "agent" ? "all changes" : "this"}
        </Button>
      ) : null}
      {canRedo ? (
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={<Redo2 />}
          onClick={() => void session.redo(turn.id)}
        >
          Redo
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={<RotateCcw />}
          onClick={() => void session.retry(turn.id)}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function RunBody({ turn, run }: { turn: Turn; run: RunView }) {
  const editor = useEditor();
  const groups = groupItems(run.items);
  const reply = replyText(run);
  const live = !isFinal(run);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <RunStatus turn={turn} run={run} />
      <PlanList run={run} />
      {groups.map((g) => {
        if (g.kind === "steps") {
          return (
            <ul key={g.key} className="flex flex-col" aria-label="Steps">
              {g.items.map((item) =>
                item.kind === "tool" ? (
                  <StepRow key={item.id} item={item} />
                ) : item.kind === "thinking" ? (
                  <ThinkingRow key={item.id} item={item} live={live} />
                ) : item.kind === "workflow" ? (
                  <li key={item.id} className="flex min-h-7 items-start gap-2.5 py-0.5">
                    <span
                      className={cn(
                        "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                        item.status === "running" && "bg-accent-tint text-accent",
                        (item.status === "done" || item.status === "skipped") &&
                          "bg-fg/6 text-success",
                        item.status === "failed" && "bg-danger/12 text-danger",
                        item.status === "pending" && "bg-fg/4 text-fg-placeholder",
                      )}
                      aria-hidden
                    >
                      {item.status === "running" ? (
                        <SunSpinner size={11} label="" />
                      ) : item.status === "failed" ? (
                        <X className="size-3" />
                      ) : item.status === "pending" ? (
                        <span className="size-1.5 rounded-full bg-current" />
                      ) : (
                        <Check className="size-3" strokeWidth={2.5} />
                      )}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 pt-[1px] text-[13px] leading-[1.35rem]",
                        item.status === "running" ? "dsn-ai-shimmer-text" : "text-fg-secondary",
                        item.status === "failed" && "text-danger",
                      )}
                    >
                      {item.label}
                    </span>
                  </li>
                ) : null,
              )}
            </ul>
          );
        }
        if (g.kind === "previews") {
          return (
            <PreviewGrid key={g.key} items={g.items as Extract<LogItem, { kind: "preview" }>[]} />
          );
        }
        const item = g.items[0] as LogItem;
        if (item.kind === "question") return <QuestionCard key={item.id} turn={turn} item={item} />;
        if (item.kind === "error") {
          return (
            <Callout
              key={item.id}
              tone={item.recoverable ? "warning" : "danger"}
              className="text-xs"
            >
              {item.message}
            </Callout>
          );
        }
        if (item.kind === "output") {
          return (
            <a
              key={item.id}
              href={item.designId ? `/design/${encodeURIComponent(item.designId)}` : undefined}
              onClick={(e) => {
                if (!item.designId) return;
                e.preventDefault();
                editor.navigate(`/design/${encodeURIComponent(item.designId)}`);
              }}
              className="flex items-center justify-between rounded-card bg-fg/[0.02] px-3 py-2 text-sm text-fg-secondary transition-colors hover:bg-fg/[0.07] hover:text-fg"
            >
              {item.label}
              {item.designId ? <ArrowUpRight className="size-4 text-fg-muted" aria-hidden /> : null}
            </a>
          );
        }
        return null;
      })}
      {reply ? (
        <RichText text={reply} className="text-sm leading-relaxed text-fg-secondary" />
      ) : run.summary && isFinal(run) ? (
        <p className="text-sm leading-relaxed text-fg-secondary">{run.summary}</p>
      ) : null}
      {run.phase === "failed" && run.error && !run.items.some((i) => i.kind === "error") ? (
        <Callout tone="danger" className="text-xs">
          {run.error}
        </Callout>
      ) : null}
      <TurnActions turn={turn} />
    </div>
  );
}

function MediaBody({ turn }: { turn: Turn }) {
  const media = turn.media;
  if (!media) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
        {media.status === "running" ? (
          <>
            <SunSpinner size={14} label="" aria-hidden />
            <span className="dsn-ai-shimmer-text text-fg-secondary">
              {media.stopping ? "Stopping" : "Working on it"}
            </span>
          </>
        ) : media.status === "done" ? (
          <>
            <CircleCheck className="size-3.5 text-success" aria-hidden />
            <span>Done</span>
            {media.credits > 0 ? (
              <span className="ml-auto inline-flex items-center gap-1 text-fg-placeholder">
                <Coins className="size-3" aria-hidden />
                {formatCredits(media.credits)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <X
              className={cn("size-3.5", media.stopping ? "text-fg-muted" : "text-danger")}
              aria-hidden
            />
            <span>{media.stopping ? "Stopped" : "Failed"}</span>
          </>
        )}
      </div>
      {media.status === "running" ? (
        <div className="dsn-ai-shimmer h-28 rounded-card bg-fg/[0.04]" aria-hidden />
      ) : null}
      {media.results.some((r) => r.url) ? (
        <div
          className={cn(
            "grid gap-2",
            media.results.length > 1 ? "grid-cols-2" : "w-fit max-w-full grid-cols-1",
          )}
        >
          {media.results.map((r, i) =>
            r.url ? (
              <img
                // biome-ignore lint/suspicious/noArrayIndexKey: results of one finished action
                key={i}
                src={r.url}
                alt="Generated result"
                className="dsn-ai-checker max-h-48 w-auto max-w-full rounded-card border border-line-subtle object-contain"
              />
            ) : null,
          )}
        </div>
      ) : null}
      {turn.error ? (
        <Callout tone="danger" className="text-xs">
          {turn.error}
        </Callout>
      ) : null}
      <TurnActions turn={turn} />
    </div>
  );
}

function WorkflowSummary({ turn }: { turn: Turn }) {
  const editor = useEditor();
  const wf = turn.workflow;
  if (!wf?.status) {
    return wf ? (
      <p className="text-xs text-fg-muted">
        Estimated {formatCredits(wf.estimatedCredits)}. Designs appear here as they are ready.
      </p>
    ) : null;
  }
  const s = wf.status;
  const done = s.status === "completed";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>
          {s.progress.done} of {s.progress.total} steps
        </span>
        <span className="inline-flex items-center gap-1 text-fg-placeholder">
          <Coins className="size-3" aria-hidden />
          {formatCredits(s.costCredits)}
        </span>
      </div>
      {!done && s.status !== "failed" && s.status !== "cancelled" ? (
        <Progress
          value={s.progress.total ? s.progress.done : null}
          max={Math.max(1, s.progress.total)}
          size="sm"
          label="Workflow progress"
        />
      ) : null}
      {s.outputs.length > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          {s.outputs
            .filter((o) => o.designId)
            .map((o) => (
              <button
                key={o.designId}
                type="button"
                onClick={() =>
                  editor.navigate(`/design/${encodeURIComponent(o.designId as string)}`)
                }
                className="group flex items-center justify-between gap-2 rounded-[8px] bg-fg/[0.02] px-2.5 py-2 text-left text-xs text-fg-secondary transition-colors hover:bg-fg/[0.07] hover:text-fg"
              >
                <span className="min-w-0 truncate">{o.label}</span>
                <ArrowUpRight
                  className="size-3.5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden
                />
              </button>
            ))}
        </div>
      ) : null}
      {s.error ? (
        <Callout tone="danger" className="text-xs">
          {s.error}
        </Callout>
      ) : null}
    </div>
  );
}

/** One exchange: what the user asked and how the AI answered (live while it runs). */
export function TurnView({ turn }: { turn: Turn }) {
  const run = turn.run;
  const working = (run && isActive(run)) || turn.media?.status === "running";
  return (
    <article className="flex flex-col gap-3" aria-label={turn.title}>
      <UserMessage turn={turn} />
      <div className="flex gap-2.5">
        <div className="pt-0.5" aria-hidden>
          <SunMark size={18} className={cn(working && "animate-sun-pulse")} />
        </div>
        <div className="min-w-0 flex-1">
          {turn.kind === "media" ? (
            <MediaBody turn={turn} />
          ) : run ? (
            <div className="flex flex-col gap-2.5">
              <RunBody turn={turn} run={run} />
              {turn.kind === "workflow" ? <WorkflowSummary turn={turn} /> : null}
            </div>
          ) : turn.error ? (
            <div className="flex flex-col gap-2">
              <Callout tone="danger" className="text-xs">
                {turn.error}
              </Callout>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <SunSpinner size={14} label="" aria-hidden />
              <span className="dsn-ai-shimmer-text">Starting</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
