"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage, isAppError } from "@/lib/errors";

export interface Slide {
  pageId: string | null;
  url: string;
}

export type SlidesState =
  | { status: "loading" }
  | { status: "ready"; slides: Slide[] }
  | { status: "error"; message: string; code: string | null };

/**
 * Slides rendered by Desyn's render worker (the same Rust renderer that produces exports), as PNG at
 * 2x. A ready PNG export newer than the design's last change is reused, so presenting again does not
 * render (or count) twice.
 */
export function useSlides(
  designId: Id<"designs">,
  share: { token: string; password?: string } | undefined,
): SlidesState {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const design = useQuery(
    api.designs.designs.get,
    isLoading ? "skip" : { designId, ...(share ? { share } : {}) },
  );
  const recent = useQuery(api.exports.exports.list, isAuthenticated ? { designId } : "skip");
  const request = useMutation(api.exports.exports.request);
  const [exportId, setExportId] = useState<Id<"exports"> | null>(null);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  const requested = useRef(false);
  const job = useQuery(api.exports.exports.status, exportId ? { exportId } : "skip");

  const reusable =
    design && recent
      ? recent.find(
          (e) =>
            e.format === "png" &&
            e.status === "ready" &&
            e.pages === "all" &&
            e.createdAt >= design.updatedAt &&
            (e.expiresAt === null || e.expiresAt > Date.now() + 10 * 60_000),
        )
      : undefined;

  useEffect(() => {
    if (!design || recent === undefined || reusable || requested.current || !isAuthenticated)
      return;
    requested.current = true;
    const dpr =
      typeof window === "undefined" ? 2 : Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const target = Math.max(window.innerWidth, 1280) * dpr;
    const scale = Math.min(
      4,
      Math.max(1, Math.round((target / Math.max(1, design.width)) * 10) / 10),
    );
    request({ designId, format: "png", pages: "all", scale, ...(share ? { share } : {}) })
      .then(setExportId)
      .catch((e: unknown) => {
        const code = isAppError(e)
          ? ((e as { data?: { code?: string } }).data?.code ?? null)
          : null;
        setError({ message: errorMessage(e), code });
      });
  }, [design, recent, reusable, isAuthenticated, request, designId, share]);

  if (error) return { status: "error", ...error };
  if (!isLoading && !isAuthenticated)
    return { status: "error", message: "", code: "UNAUTHENTICATED" };
  const done = reusable ?? (job?.status === "ready" ? job : null);
  if (done) {
    return {
      status: "ready",
      slides: done.files.flatMap((f) => (f.url ? [{ pageId: f.pageId, url: f.url }] : [])),
    };
  }
  if (job?.status === "failed" || job?.status === "expired") {
    return { status: "error", message: job.error ?? "", code: "RENDER_FAILED" };
  }
  return { status: "loading" };
}
