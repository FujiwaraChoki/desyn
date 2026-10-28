"use client";

import { SegmentedControl, Slider, Switch, toast, useTheme } from "@desyn/ui";
import { useMutation } from "convex/react";
import { useApp } from "@/components/app/app-context";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { SettingsCard, SettingsPage, SettingsRow } from "./settings-ui";

type Theme = "system" | "dark" | "light";

export function AppearanceSettings() {
  const t = useT();
  const { me } = useApp();
  const { theme, setTheme } = useTheme();
  const update = useMutation(api.accounts.profiles.update);
  const appearance = me.appearance;
  const save = (patch: Record<string, unknown>) =>
    void update({ appearance: patch }).catch((e: unknown) => toast.error(errorMessage(e)));
  const chooseTheme = (next: Theme) => {
    setTheme(next);
    save({ theme: next });
  };
  return (
    <SettingsPage
      title={t("settings.appearance.title")}
      description={t("settings.appearance.subtitle")}
    >
      <SettingsCard>
        <SettingsRow label={t("settings.appearance.theme")}>
          <SegmentedControl
            options={[
              { value: "system", label: t("settings.appearance.themeSystem") },
              { value: "dark", label: t("settings.appearance.themeDark") },
              { value: "light", label: t("settings.appearance.themeLight") },
            ]}
            value={theme}
            onValueChange={chooseTheme}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.appearance.reducedMotion")}
          description={t("settings.appearance.reducedMotionBody")}
        >
          <Switch
            checked={appearance.reducedMotion ?? false}
            aria-label={t("settings.appearance.reducedMotion")}
            onCheckedChange={(on) => save({ reducedMotion: on })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.appearance.density")}>
          <SegmentedControl
            options={[
              { value: "comfortable", label: t("settings.appearance.comfortable") },
              { value: "compact", label: t("settings.appearance.compact") },
            ]}
            value={appearance.density ?? "comfortable"}
            onValueChange={(density) => save({ density })}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.appearance.uiScale")}
          description={`${Math.round((appearance.uiScale ?? 1) * 100)}%`}
        >
          <Slider
            className="w-48"
            min={0.75}
            max={1.5}
            step={0.05}
            defaultValue={[appearance.uiScale ?? 1]}
            onValueCommit={([v]) => v !== undefined && save({ uiScale: Math.round(v * 100) / 100 })}
            formatValue={(v) => `${Math.round(v * 100)}%`}
            aria-label={t("settings.appearance.uiScale")}
          />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard title={t("settings.appearance.canvas")}>
        <SettingsRow label={t("settings.appearance.grid")}>
          <Switch
            checked={appearance.canvasGrid ?? true}
            aria-label={t("settings.appearance.grid")}
            onCheckedChange={(on) => save({ canvasGrid: on })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.appearance.snapping")}>
          <Switch
            checked={appearance.snapping ?? true}
            aria-label={t("settings.appearance.snapping")}
            onCheckedChange={(on) => save({ snapping: on })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.appearance.rulers")}>
          <Switch
            checked={appearance.rulers ?? false}
            aria-label={t("settings.appearance.rulers")}
            onCheckedChange={(on) => save({ rulers: on })}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
}
