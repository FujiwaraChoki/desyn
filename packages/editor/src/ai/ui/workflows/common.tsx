"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProBadge,
} from "@desyn/ui";
import { Coins } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { WorkflowType } from "../../backend/types.ts";
import { type AiAction, gate, upgradeMessage } from "../../core/gating.ts";
import { formatCredits } from "../../core/prompt.ts";
import { useAi } from "../hooks.ts";
import { UpgradeCard } from "../notices.tsx";

type AiModule = typeof import("@desyn/ai");

let modulePromise: Promise<AiModule> | null = null;

/** @desyn/ai, loaded on first use (workflow dialogs need its schemas, estimates and reflow). */
export function loadAi(): Promise<AiModule> {
  modulePromise ??= import("@desyn/ai");
  return modulePromise;
}

export function useAiModule(): AiModule | null {
  const [mod, setMod] = useState<AiModule | null>(null);
  useEffect(() => {
    let alive = true;
    void loadAi().then((m) => alive && setMod(m));
    return () => {
      alive = false;
    };
  }, []);
  return mod;
}

/**
 * Credit estimate of a workflow input (@desyn/ai `estimateWorkflow`, the same function the server reserves
 * with). Null while loading or when the input is not valid yet.
 */
export function useWorkflowEstimate(
  type: WorkflowType,
  input: Record<string, unknown> | null,
): number | null {
  const ai = useAiModule();
  const key = input ? JSON.stringify(input) : "";
  const [estimate, setEstimate] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized input
  useEffect(() => {
    if (!ai || !input) {
      setEstimate(null);
      return;
    }
    const t = setTimeout(() => {
      try {
        setEstimate(ai.estimateWorkflow(type, { designId: "current", ...input }).total);
      } catch {
        setEstimate(null);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [ai, type, key]);
  return estimate;
}

/** Shared frame of the workflow dialogs: serif title, gating, estimate and the start action. */
export function WorkflowDialog({
  action,
  title,
  description,
  close,
  estimate,
  startLabel,
  canStart,
  onStart,
  busy,
  estimateHint,
  children,
  size = "lg",
}: {
  action: AiAction;
  title: ReactNode;
  description: string;
  close: () => void;
  estimate: number | null;
  startLabel: string;
  canStart: boolean;
  onStart: () => void;
  busy?: boolean;
  /** Shown instead of the estimate while the form is incomplete. */
  estimateHint?: string;
  children: ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const g = gate(
    useAi((s) => s.account),
    action,
  );
  const remaining = useAi((s) => s.credits?.remaining ?? null);
  const locked = g.state === "upgrade";
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>{title}</span>
            {locked ? <ProBadge /> : null}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-4">
          {locked && g.state === "upgrade" ? (
            <div className="mb-4">
              <UpgradeCard message={upgradeMessage(g.feature)} compact />
            </div>
          ) : null}
          {children}
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <Coins className="size-3.5" aria-hidden />
            {estimate === null
              ? (estimateHint ?? "Estimating…")
              : `About ${formatCredits(estimate)}`}
            {remaining !== null && estimate !== null ? (
              <span className="text-fg-placeholder">· {remaining} left</span>
            ) : null}
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canStart || locked}
              loading={busy}
              onClick={onStart}
            >
              {startLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Small uppercase-free label above a group of controls. */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-fg-secondary">
      {children}
    </label>
  );
}
