"use client";

import { getPlan } from "@desyn/schema";
import { Button, cn, IconButton, ProBadge } from "@desyn/ui";
import { Info, MailCheck, TriangleAlert, X } from "lucide-react";
import { useEditor } from "../../context.tsx";
import { UPGRADE_HREF } from "../core/gating.ts";
import type { DockNotice } from "../session.ts";
import { useAiSession } from "./hooks.ts";

const PRO_PRICE = getPlan("pro").priceMonthly;

/** Upgrade call to action for a Pro feature (free tier). */
export function UpgradeCard({
  message,
  onDismiss,
  compact = false,
}: {
  message: string;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const editor = useEditor();
  return (
    <div
      role="status"
      className={cn(
        "relative overflow-hidden rounded-card border border-line-subtle bg-surface-1 shadow-popover",
        compact ? "p-3" : "p-4",
      )}
    >
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ProBadge />
            {!compact ? (
              <span className="text-2xs text-fg-muted">${PRO_PRICE} a month · fair use</span>
            ) : null}
          </div>
          <p
            className={cn(
              "mt-2 font-serif leading-snug text-fg",
              compact ? "text-[17px]" : "text-xl",
            )}
          >
            {message.replace(/ is part of Pro\.$/, "")} <em className="text-accent">with Pro</em>
          </p>
          {!compact ? (
            <p className="mt-1 text-xs text-fg-muted">
              The AI agent, generative images, brand kits and workflows. Bring your own keys at no
              extra cost.
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => editor.navigate(UPGRADE_HREF)}>
              Upgrade to Pro
            </Button>
            {onDismiss ? (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Not now
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The dock's notice line (upgrade, verification, sign-in, info, error). */
export function NoticeView({ notice }: { notice: DockNotice }) {
  const session = useAiSession();
  const editor = useEditor();
  const dismiss = () => session.dismissNotice();
  if (notice.kind === "upgrade")
    return <UpgradeCard message={notice.message} onDismiss={dismiss} />;
  const content =
    notice.kind === "unverified"
      ? {
          icon: <MailCheck className="size-4 text-accent-text" aria-hidden />,
          text: "Verify your email address to use the AI.",
          action: (
            <Button size="xs" variant="secondary" onClick={() => editor.navigate("/verify")}>
              Verify email
            </Button>
          ),
        }
      : notice.kind === "signed-out"
        ? {
            icon: <Info className="size-4 text-info" aria-hidden />,
            text: "Sign in to ask the AI about this design.",
            action: (
              <Button size="xs" variant="secondary" onClick={() => editor.navigate("/login")}>
                Sign in
              </Button>
            ),
          }
        : notice.kind === "error"
          ? {
              icon: <TriangleAlert className="size-4 text-danger" aria-hidden />,
              text: notice.message,
              action: null,
            }
          : {
              icon: <Info className="size-4 text-fg-muted" aria-hidden />,
              text: notice.message,
              action: null,
            };
  return (
    <div
      role={notice.kind === "error" ? "alert" : "status"}
      className="flex items-center gap-2.5 rounded-card border border-line-subtle bg-surface-2 px-3 py-2 shadow-popover text-xs text-fg-secondary"
    >
      {content.icon}
      <span className="min-w-0 flex-1">{content.text}</span>
      {content.action}
      <IconButton label="Dismiss" size="xs" tooltip={false} onClick={dismiss}>
        <X />
      </IconButton>
    </div>
  );
}
