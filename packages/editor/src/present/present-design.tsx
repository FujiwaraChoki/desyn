"use client";

import type { Design } from "@desyn/schema";
import { Button, EmptyState, SunSpinner, ThemeScope } from "@desyn/ui";
import { type ConvexReactClient, useConvex } from "convex/react";
import { MonitorX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../collab/live.ts";
import { AssetService } from "../sync/assets.ts";
import { createConvexBackend } from "../sync/convex-transport.ts";
import { assembleDesign, type LoadPage, type ShareArg } from "../sync/wire.ts";
import { Presenter } from "./presenter.tsx";

export interface PresentDesignProps {
  /** Convex `designs` id. */
  designId: string;
  /** Share-link access (token + password) for `/present/[id]?share=...`. */
  share?: ShareArg;
  /** 1-based slide to start from (`?slide=`). */
  slide?: number;
  /** Where "End presentation" goes. */
  onExit: () => void;
  onSlideChange?: (slide: number) => void;
  /** Convex client (default: the one from <ConvexProvider>). */
  convex?: ConvexReactClient;
  presenterView?: boolean;
}

/**
 * The presenter for a stored design (apps/web `/present/[id]`): loads the design (paginated, as the
 * editor does), resolves signed asset URLs and presents it with transitions and animations rendered by the
 * engine. Needs <ConvexProvider> (or `convex`) and @desyn/ui's <DesynProvider> above it.
 */
export function PresentDesign({
  designId,
  share,
  slide = 1,
  onExit,
  onSlideChange,
  convex,
  presenterView,
}: PresentDesignProps) {
  const contextClient = useConvex() as ConvexReactClient | undefined;
  const client = convex ?? contextClient;
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shareToken = share?.token;
  const sharePassword = share?.password;
  const backend = useMemo(
    () =>
      client
        ? createConvexBackend(
            client,
            designId,
            shareToken
              ? { token: shareToken, ...(sharePassword ? { password: sharePassword } : {}) }
              : undefined,
          )
        : null,
    [client, designId, shareToken, sharePassword],
  );
  const slideChanged = useCallback((i: number) => onSlideChange?.(i + 1), [onSlideChange]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const assets = useMemo(
    () => (backend ? new AssetService(backend.assets, () => workspaceId) : null),
    [backend, workspaceId],
  );

  useEffect(() => {
    if (!backend) return;
    let alive = true;
    setDesign(null);
    setError(null);
    void (async () => {
      try {
        const pages: LoadPage[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 1000; i++) {
          const page: LoadPage = await backend.sync.load(cursor);
          pages.push(page);
          if (page.isDone) break;
          cursor = page.cursor;
        }
        if (!alive) return;
        const { design: d } = assembleDesign(pages);
        setWorkspaceId(pages[0]?.header?.workspaceId ?? null);
        setDesign(d);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [backend]);

  if (error || !client) {
    return (
      <ThemeScope theme="dark" className="fixed inset-0 grid place-items-center bg-black">
        <EmptyState
          icon={<MonitorX />}
          title={
            <>
              can't <em className="text-accent">present</em> this design
            </>
          }
          description={error ?? "The presenter has no connection to the Desyn backend."}
          action={
            <Button variant="secondary" onClick={onExit}>
              Go back
            </Button>
          }
        />
      </ThemeScope>
    );
  }
  if (!design || !assets) {
    return (
      <ThemeScope theme="dark" className="fixed inset-0 grid place-items-center bg-black">
        <SunSpinner size="lg" label="Loading the presentation" />
      </ThemeScope>
    );
  }
  return (
    <Presenter
      design={design}
      resolveAsset={(asset) => assets.urlFor(asset)}
      startIndex={Math.max(0, slide - 1)}
      onExit={onExit}
      onSlideChange={slideChanged}
      {...(presenterView !== undefined ? { presenterView } : {})}
    />
  );
}
