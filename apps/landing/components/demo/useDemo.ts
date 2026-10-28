"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BLUEPRINTS, BUILD_LOG, BUILD_ORDER } from "@/lib/demo/blueprints";
import { applyEdit, createDesign, moveLayer, toggleVisibility } from "@/lib/demo/edits";
import { blueprintForPrompt, EDIT_LABELS, editForInstruction } from "@/lib/demo/prompt";
import type { DemoDesign, EditId } from "@/lib/demo/types";

export interface LogEntry {
  id: number;
  who: "you" | "ai";
  text: string;
  status: "running" | "done" | "note";
}

export type Phase = "idle" | "generating" | "ready" | "editing";

export interface DemoState {
  phase: Phase;
  design: DemoDesign | null;
  placed: string[];
  history: DemoDesign[];
  log: LogEntry[];
  selected: string | null;
  glow: string[];
  sweep: number;
  runs: number;
}

const INITIAL: DemoState = {
  phase: "idle",
  design: null,
  placed: [],
  history: [],
  log: [],
  selected: null,
  glow: [],
  sweep: 0,
  runs: 0,
};

/** Suggestions double as blueprint labels; their designs keep the blueprint's own headline. */
export const PROMPT_SUGGESTIONS = Object.values(BLUEPRINTS).map((b) => b.label);

const NEW_DESIGN_HINT =
  /\b(poster|post|flyer|banner|story|invite|invitation|card|cover|ad|design|thumbnail|menu)\b/i;
const LOG_LIMIT = 6;

let logSeq = 0;
const entry = (who: LogEntry["who"], text: string, status: LogEntry["status"]): LogEntry => ({
  id: ++logSeq,
  who,
  text,
  status,
});

function settle(log: LogEntry[]): LogEntry[] {
  return log.map((l) => (l.status === "running" ? { ...l, status: "done" } : l));
}

function push(log: LogEntry[], ...items: LogEntry[]): LogEntry[] {
  return [...settle(log), ...items].slice(-LOG_LIMIT);
}

export function useDemo(reducedMotion: boolean) {
  const [state, setState] = useState<DemoState>(INITIAL);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const schedule = useCallback(
    (fn: () => void, ms: number) => {
      timers.current.push(setTimeout(fn, reducedMotion ? Math.min(ms, 60) : ms));
    },
    [reducedMotion],
  );

  useEffect(() => clearTimers, [clearTimers]);

  const generate = useCallback(
    (prompt: string) => {
      clearTimers();
      const suggestion = PROMPT_SUGGESTIONS.includes(prompt);
      const bpId = blueprintForPrompt(prompt, stateRef.current.runs);
      const design = createDesign(bpId, suggestion ? undefined : prompt);
      const bp = BLUEPRINTS[bpId];
      setState((s) => ({
        ...s,
        phase: "generating",
        design,
        placed: [],
        history: [],
        selected: null,
        glow: [],
        runs: s.runs + 1,
        log: push(
          s.log,
          entry("you", prompt, "done"),
          entry("ai", `Planning: ${bp.plan}`, "running"),
        ),
      }));
      const step = 560;
      BUILD_ORDER.forEach((id, i) => {
        schedule(
          () => {
            setState((s) => ({
              ...s,
              placed: [...s.placed, id],
              glow: [id],
              log: push(s.log, entry("ai", BUILD_LOG[id], "running")),
            }));
          },
          900 + i * step,
        );
      });
      schedule(
        () => {
          setState((s) => ({
            ...s,
            phase: "ready",
            glow: [],
            sweep: s.sweep + 1,
            log: push(
              s.log,
              entry("ai", `Done. ${BUILD_ORDER.length} editable layers. Ask for a change.`, "done"),
            ),
          }));
        },
        900 + BUILD_ORDER.length * step + 300,
      );
    },
    [clearTimers, schedule],
  );

  const edit = useCallback(
    (editId: EditId, said?: string) => {
      const s0 = stateRef.current;
      if (s0.phase !== "ready" || !s0.design) return;
      clearTimers();
      const result = applyEdit(s0.design, editId);
      setState((s) => ({
        ...s,
        phase: "editing",
        log: push(
          s.log,
          entry("you", said ?? EDIT_LABELS[editId], "done"),
          entry("ai", "Reading the canvas", "running"),
        ),
      }));
      schedule(() => {
        if (result.touched.length === 0) {
          setState((s) => ({
            ...s,
            phase: "ready",
            log: push(s.log, entry("ai", result.summary, "note")),
          }));
          return;
        }
        setState((s) => ({
          ...s,
          design: result.design,
          history: s.design ? [...s.history, s.design].slice(-20) : s.history,
          glow: result.touched,
          log: push(
            s.log,
            entry(
              "ai",
              `${result.summary} ${result.touched.length} of ${result.design.layers.length} layers changed.`,
              "done",
            ),
          ),
        }));
        schedule(
          () => setState((s) => ({ ...s, phase: "ready", glow: [], sweep: s.sweep + 1 })),
          1500,
        );
      }, 650);
    },
    [clearTimers, schedule],
  );

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const s = stateRef.current;
      if (s.phase === "generating" || s.phase === "editing") return;
      if (s.phase === "idle" || !s.design) {
        generate(text);
        return;
      }
      const match = editForInstruction(text, BLUEPRINTS[s.design.blueprint].edits);
      if (match) {
        edit(match, text);
        return;
      }
      if (NEW_DESIGN_HINT.test(text)) {
        generate(text);
        return;
      }
      setState((st) => ({
        ...st,
        log: push(
          st.log,
          entry("you", text, "done"),
          entry(
            "ai",
            "This demo only knows the edits below. In Desyn the agent can do anything you can do by hand.",
            "note",
          ),
        ),
      }));
    },
    [edit, generate],
  );

  const undo = useCallback(() => {
    setState((s) => {
      const prev = s.history.at(-1);
      if (!prev || s.phase !== "ready") return s;
      return {
        ...s,
        design: prev,
        history: s.history.slice(0, -1),
        log: push(s.log, entry("ai", "Undone. One step back.", "note")),
      };
    });
  }, []);

  const select = useCallback((id: string | null) => setState((s) => ({ ...s, selected: id })), []);

  const move = useCallback((id: string, x: number, y: number, commit: boolean) => {
    setState((s) => {
      if (!s.design) return s;
      const next = moveLayer(s.design, id, x, y);
      if (next === s.design) return s;
      return {
        ...s,
        design: next,
        history: commit ? [...s.history, s.design].slice(-20) : s.history,
      };
    });
  }, []);

  /** Starts a drag gesture: snapshot once so the whole drag is one undo step. */
  const beginMove = useCallback(() => {
    setState((s) => (s.design ? { ...s, history: [...s.history, s.design].slice(-20) } : s));
  }, []);

  const toggle = useCallback((id: string) => {
    setState((s) => (s.design ? { ...s, design: toggleVisibility(s.design, id) } : s));
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    setState((s) => ({ ...INITIAL, runs: s.runs }));
  }, [clearTimers]);

  return { state, generate, edit, submit, undo, select, move, beginMove, toggle, reset };
}
