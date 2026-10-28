"use client";

import { can, FEATURE_KEYS, type FeatureKey, type PlanId } from "@desyn/schema";
import { useMemo } from "react";
import { useLive } from "../collab/live.ts";
import { useEditor, useEditorStore } from "../context.tsx";
import { exportOf } from "./run.ts";

export function featuresOfPlan(plan: PlanId): Record<FeatureKey, boolean> {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, can(plan, k)])) as Record<
    FeatureKey,
    boolean
  >;
}

export interface ExportFeatures {
  features: Partial<Record<FeatureKey, boolean>>;
  /** Plan known (false while loading: the dialog shows formats without locking them yet). */
  known: boolean;
}

/**
 * Plan features for exports: the signed-in user's resolved features (`profiles.me`); visitors get the Free
 * plan, except on self-hosted deployments where everything is unlocked.
 */
export function useExportFeatures(): ExportFeatures {
  const editor = useEditor();
  const backend = exportOf(editor)?.backend ?? null;
  const signedIn = useEditorStore((s) => s.user !== null);
  const userId = useEditorStore((s) => s.user?.id ?? "anon");
  const account = useLive(
    backend && signedIn ? `me:${userId}` : null,
    () => backend?.account() ?? null,
  );
  const config = useLive(backend && !signedIn ? "config" : null, () => backend?.edition() ?? null);
  return useMemo(() => {
    if (!backend) return { features: featuresOfPlan("selfhost"), known: true };
    if (signedIn) {
      const f = account.data?.features;
      return f
        ? { features: f as Partial<Record<FeatureKey, boolean>>, known: true }
        : { features: featuresOfPlan("free"), known: false };
    }
    const edition = config.data?.edition;
    if (!edition) return { features: featuresOfPlan("free"), known: false };
    return { features: featuresOfPlan(edition === "selfhost" ? "selfhost" : "free"), known: true };
  }, [backend, signedIn, account.data, config.data]);
}
