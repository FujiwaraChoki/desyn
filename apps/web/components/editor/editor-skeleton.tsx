"use client";

import { Logo, Skeleton, SunSpinner } from "@desyn/ui";
import { useQuery } from "convex/react";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Id } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { shareArg } from "@/lib/share-access";

/**
 * The editor's silhouette while its code and the design load: top bar, tool rail, canvas with the
 * first page at its real aspect ratio, inspector and tool dock. Shapes match the editor layout in
 * DESIGN_SYSTEM.md §6 so the real editor fades in without a jump.
 */
export function EditorSkeleton({
  designId,
  shareToken,
  exitHref,
}: {
  designId: string;
  shareToken?: string;
  exitHref: string;
}) {
  const t = useT();
  // Password-protected links: the password unlocked on /share/[token] lives in sessionStorage, read
  // after mount (no storage on the server render).
  const [share, setShare] = useState<ReturnType<typeof shareArg> | null>(null);
  useEffect(() => setShare(shareArg(shareToken) ?? undefined), [shareToken]);
  const design = useQuery(
    api.designs.designs.get,
    shareToken && share === null
      ? "skip"
      : { designId: designId as Id<"designs">, ...(share ? { share } : {}) },
  );
  const ratio =
    design && design.width > 0 && design.height > 0 ? design.width / design.height : 4 / 5;
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-fg" aria-busy="true">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle bg-surface-1 px-2">
        <Link
          href={exitHref}
          aria-label={t("editor.back")}
          className="flex items-center gap-1 rounded-control px-1.5 py-1 text-fg-muted hover:bg-fg/6 hover:text-fg"
        >
          <ChevronLeft className="size-4" />
          <Logo variant="mark" size={18} />
        </Link>
        <div className="h-5 w-px bg-line-subtle" />
        {design ? (
          <span className="truncate px-2 text-sm text-fg-secondary">{design.name}</span>
        ) : (
          <Skeleton className="h-4 w-40" />
        )}
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="hidden h-7 w-16 rounded-full sm:block" />
          <Skeleton className="h-7 w-20" />
          <div className="h-7 w-20 rounded-control bg-fg/10" />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-14 shrink-0 flex-col items-center gap-3 border-r border-line-subtle bg-surface-1 py-3 sm:flex">
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="size-8 rounded-[8px]" />
          ))}
        </aside>
        <main className="relative grid min-w-0 flex-1 place-items-center dot-grid">
          <div
            className="relative grid max-h-[72%] max-w-[72%] place-items-center overflow-hidden rounded-[3px] bg-surface-2 shadow-page"
            style={{
              aspectRatio: `${ratio}`,
              width: ratio >= 1 ? "72%" : "auto",
              height: ratio >= 1 ? "auto" : "72%",
            }}
          >
            <div className="dsn-shimmer animate-shimmer absolute inset-0 opacity-60" />
            <div className="relative flex flex-col items-center gap-3 p-6 text-center text-accent">
              <SunSpinner size={28} label={t("editor.loading")} />
              <p className="text-sm text-fg-secondary">{t("editor.loading")}</p>
            </div>
          </div>
          <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-subtle bg-glass px-3 py-2 shadow-popover backdrop-blur-[20px]">
            {Array.from({ length: 7 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="size-7 rounded-full" />
            ))}
          </div>
        </main>
        <aside className="hidden w-[280px] shrink-0 flex-col gap-4 border-l border-line-subtle bg-surface-1 p-4 lg:flex">
          <Skeleton className="h-7 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
