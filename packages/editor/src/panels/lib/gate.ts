import { useCallback } from "react";
import { useEditor } from "../../context.tsx";
import { usePlanFeatures } from "../backend.ts";

/**
 * Plan gating in the panels (config/plans.json features, read from `accounts/profiles:me`). Without a known
 * plan nothing is gated here: the server still enforces its own checks.
 */

const FEATURE_NAMES: Record<string, string> = {
  charts: "Charts",
  tables: "Tables",
  qr: "QR codes",
  "layout.auto": "Auto layout",
  "effects.advanced": "Advanced effects",
  brandKit: "Brand kits",
  "templates.premium": "Premium templates",
  "fonts.custom": "Custom fonts",
  presentation: "Animations",
};

export interface Gate {
  /** True when the plan lacks the feature (shows a PRO pill). */
  locked: (feature: string) => boolean;
  /** Returns true when allowed; otherwise tells the user how to unlock it. */
  check: (feature: string) => boolean;
}

export function useGate(): Gate {
  const editor = useEditor();
  const features = usePlanFeatures();
  const locked = useCallback(
    (feature: string) => features !== null && features[feature] === false,
    [features],
  );
  const check = useCallback(
    (feature: string) => {
      if (!locked(feature)) return true;
      editor.notify({
        kind: "info",
        title: `${FEATURE_NAMES[feature] ?? "This feature"} ${FEATURE_NAMES[feature]?.endsWith("s") ? "are" : "is"} part of Desyn Pro`,
        description: "Upgrade in Settings → Billing to unlock it.",
      });
      editor.telemetry("panel_gated", { feature });
      return false;
    },
    [editor, locked],
  );
  return { locked, check };
}
