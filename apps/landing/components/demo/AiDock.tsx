"use client";

import { ArrowUp, Check, RotateCcw, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { BLUEPRINTS } from "@/lib/demo/blueprints";
import { EDIT_LABELS } from "@/lib/demo/prompt";
import type { EditId } from "@/lib/demo/types";
import { type DemoState, PROMPT_SUGGESTIONS } from "./useDemo";

interface Props {
  state: DemoState;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onEdit: (id: EditId) => void;
  onUndo: () => void;
  onReset: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onInteract: () => void;
}

function Chip({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-fg/10 bg-surface-2/70 px-3 text-[12.5px] text-fg/75 transition-[color,border-color,background-color,opacity] duration-200 hover:border-sun/50 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function AiDock({
  state,
  value,
  onChange,
  onSubmit,
  onEdit,
  onUndo,
  onReset,
  inputRef,
  onInteract,
}: Props) {
  const busy = state.phase === "generating" || state.phase === "editing";
  const ready = state.phase === "ready";
  const edits = state.design ? BLUEPRINTS[state.design.blueprint].edits : [];
  const placeholder = busy
    ? "Working on it…"
    : state.design
      ? "Ask for a change…"
      : "Describe a design…";
  const recent = state.log.slice(-3);

  return (
    <div className="glass panel-edge w-full overflow-hidden rounded-[18px]">
      <div aria-live="polite" className="flex min-h-[92px] flex-col justify-end gap-1.5 px-4 pt-3">
        <AnimatePresence initial={false} mode="popLayout">
          {recent.length === 0 ? (
            <motion.p
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pb-1 text-[13px] leading-5 text-subtle"
            >
              Type anything, or pick a suggestion. Watch it build, then ask for changes.
            </motion.p>
          ) : (
            recent.map((e) => (
              <motion.div
                key={e.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className={e.who === "you" ? "flex justify-end" : "flex items-start gap-2"}
              >
                {e.who === "you" ? (
                  <span className="max-w-[85%] truncate rounded-full bg-fg/[0.08] px-3 py-1 text-[12.5px] text-fg/85">
                    {e.text}
                  </span>
                ) : (
                  <>
                    <span className="mt-[3px] grid size-[14px] shrink-0 place-items-center">
                      {e.status === "running" ? (
                        <span className="sun-spinner" />
                      ) : e.status === "done" ? (
                        <Check size={13} strokeWidth={2} className="text-sun" aria-hidden="true" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-fg/40" />
                      )}
                    </span>
                    <span
                      className={`text-[12.5px] leading-5 ${e.status === "running" ? "text-fg/90" : "text-fg/60"}`}
                    >
                      {e.text}
                    </span>
                  </>
                )}
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      <form
        className="mx-2 mt-2 flex items-center gap-2 rounded-[13px] border border-fg/10 bg-bg/50 p-1.5 pl-3.5 transition-colors focus-within:border-sun/50"
        onSubmit={(e) => {
          e.preventDefault();
          onInteract();
          onSubmit(value);
          onChange("");
        }}
      >
        <label htmlFor="demo-prompt" className="sr-only">
          Prompt for the demo AI
        </label>
        <input
          id="demo-prompt"
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onInteract();
            onChange(e.target.value);
          }}
          onFocus={onInteract}
          placeholder={placeholder}
          autoComplete="off"
          maxLength={120}
          className="h-9 min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={busy || !value.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-sun text-on-sun transition-opacity disabled:opacity-35"
        >
          {busy ? (
            <span className="sun-spinner [--sun:var(--on-sun)]" />
          ) : (
            <ArrowUp size={17} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </form>

      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-2 pb-2.5 pt-2">
        {!state.design || state.phase === "idle" ? (
          PROMPT_SUGGESTIONS.map((s) => (
            <Chip
              key={s}
              disabled={busy}
              onClick={() => {
                onInteract();
                onSubmit(s);
              }}
            >
              {s}
            </Chip>
          ))
        ) : (
          <>
            {edits.map((id) => (
              <Chip
                key={id}
                disabled={!ready}
                onClick={() => {
                  onInteract();
                  onEdit(id);
                }}
              >
                {EDIT_LABELS[id]}
              </Chip>
            ))}
            <Chip
              disabled={!ready || state.history.length === 0}
              onClick={() => {
                onInteract();
                onUndo();
              }}
            >
              <Undo2 size={13} strokeWidth={1.5} aria-hidden="true" /> Undo
            </Chip>
            <Chip
              disabled={busy}
              onClick={() => {
                onInteract();
                onReset();
              }}
            >
              <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" /> New design
            </Chip>
          </>
        )}
      </div>
    </div>
  );
}
