"use client";

import { Button, type ButtonProps, cn, ProBadge } from "@desyn/ui";
import type { ReactNode } from "react";
import { type AiAction, gate } from "../core/gating.ts";
import { formatCredits } from "../core/prompt.ts";
import { useAi } from "./hooks.ts";

/** True when the plan lacks the features for `action` (the control shows a PRO badge). */
export function useLocked(action: AiAction): boolean {
  return useAi((s) => gate(s.account, action).state === "upgrade");
}

/** A button for an AI action: PRO badge when the plan lacks it, otherwise the credit cost. */
export function AiActionButton({
  action,
  credits,
  children,
  className,
  ...props
}: Omit<ButtonProps, "children"> & {
  action: AiAction;
  credits?: number | null;
  children: ReactNode;
}) {
  const locked = useLocked(action);
  const browser = useAi((s) => s.execution.current.where === "browser");
  return (
    <Button className={cn("justify-between", className)} {...props}>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {locked ? (
        <ProBadge />
      ) : credits !== undefined && credits !== null ? (
        <span className="ml-2 shrink-0 font-sans text-2xs font-normal opacity-70">
          {browser && (action.startsWith("agent") || action === "copy" || action === "translate")
            ? "free"
            : formatCredits(credits)}
        </span>
      ) : null}
    </Button>
  );
}

/** Section of an AI panel: small label, optional PRO badge, content. */
export function AiSection({
  id,
  title,
  description,
  locked,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  locked?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 border-b border-line-subtle px-4 py-4 last:border-b-0">
      <header className="mb-3 flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg">{title}</h3>
        {locked ? <ProBadge /> : null}
      </header>
      {description ? (
        <p className="-mt-2 mb-3 text-2xs leading-relaxed text-fg-muted">{description}</p>
      ) : null}
      {children}
    </section>
  );
}
