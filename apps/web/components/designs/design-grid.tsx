"use client";

import { Button, cn, Skeleton } from "@desyn/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";
import { type CardMode, DesignCard } from "./design-card";
import type { DesignSummary } from "./use-design-actions";

export const GRID =
  "grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] sm:gap-x-5 sm:gap-y-7";

export function DesignGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex flex-col gap-2.5">
          <Skeleton className="aspect-[4/3] w-full rounded-[12px]" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A paginated grid of designs (Convex usePaginatedQuery results) with infinite loading. */
export function DesignGrid({
  designs,
  status,
  loadMore,
  mode = "active",
  empty,
  pageSize = 24,
  className,
}: {
  designs: DesignSummary[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (n: number) => void;
  mode?: CardMode;
  empty: ReactNode;
  pageSize?: number;
  className?: string;
}) {
  const t = useT();
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || status !== "CanLoadMore") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore(pageSize);
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [status, loadMore, pageSize]);

  if (status === "LoadingFirstPage") return <DesignGridSkeleton />;
  if (designs.length === 0) return <>{empty}</>;
  return (
    <div className={cn("flex flex-col gap-8", className)}>
      <div className={GRID}>
        {designs.map((d, i) => (
          <DesignCard key={d.id} design={d} mode={mode} index={i} />
        ))}
      </div>
      <div ref={sentinel} />
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            loading={status === "LoadingMore"}
            onClick={() => loadMore(pageSize)}
          >
            {t("dashboard.filters.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
