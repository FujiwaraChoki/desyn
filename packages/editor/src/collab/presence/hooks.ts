"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "../../context.tsx";
import { useCollab, useCollabStore } from "../state.ts";
import { type Collaborator, peopleOf, reducePresence } from "./reduce.ts";

/** Other sessions on this design (re-evaluated when rows change and every few seconds for expiry). */
export function useCollaborators(): Collaborator[] {
  const { sessionId } = useCollab();
  const rows = useCollabStore((s) => s.rows);
  const userId = useEditorStore((s) => s.user?.id ?? null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-evaluates expiry against the clock
  return useMemo(
    () => reducePresence(rows, { sessionId, userId, now: Date.now() }),
    [rows, sessionId, userId, tick],
  );
}

export function usePeople() {
  const collaborators = useCollaborators();
  return useMemo(() => peopleOf(collaborators), [collaborators]);
}
