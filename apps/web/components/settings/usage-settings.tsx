"use client";

import { CircularProgress, cn, Progress, Skeleton } from "@desyn/ui";
import { useQuery } from "convex/react";
import { Check, Gauge } from "lucide-react";
import { useApp } from "@/components/app/app-context";
import { api } from "@/lib/convex-api";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { CreditHistory } from "./billing-settings";
import { SettingsCard, SettingsPage } from "./settings-ui";

function Meter({
  label,
  used,
  limit,
  ratio,
  format,
}: {
  label: string;
  used: number;
  limit: number | null;
  ratio: number | null;
  format: (n: number) => string;
}) {
  const t = useT();
  const high = ratio !== null && ratio >= 0.9;
  return (
    <div>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-xl leading-tight font-medium text-fg tabular-nums">
        {format(used)}
        <span className="ml-1.5 text-xs font-normal text-fg-muted">
          {limit === null ? t("settings.usage.unlimited") : `/ ${format(limit)}`}
        </span>
      </p>
      {ratio !== null ? (
        <Progress
          className={cn("mt-3", high && "[&>div]:bg-danger")}
          size="sm"
          value={Math.round(ratio * 100)}
          label={label}
        />
      ) : (
        <div className="mt-3 h-1" />
      )}
    </div>
  );
}

export function UsageSettings() {
  const t = useT();
  const locale = useLocale();
  const { me } = useApp();
  const summary = useQuery(api.billing.usage.summary, {});
  if (!summary) {
    return (
      <SettingsPage title={t("settings.usage.title")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </SettingsPage>
    );
  }
  const n = (v: number) => formatNumber(v, locale);
  const m = summary.meters;
  const c = summary.credits;
  const creditsUnlimited = c.granted === null;
  const nextPeriod = (() => {
    const [y, mo] = summary.period.split("-").map(Number);
    return y && mo ? Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) : null;
  })();

  return (
    <SettingsPage
      title={t("settings.usage.title")}
      description={t("settings.usage.subtitle", { period: summary.period })}
    >
      {me.features["ai.agent"] ? (
        <SettingsCard>
          <div className="flex items-center gap-4">
            <CircularProgress
              size={56}
              strokeWidth={5}
              value={creditsUnlimited ? 100 : (c.remaining ?? 0)}
              max={creditsUnlimited ? 100 : Math.max(1, c.granted ?? 1)}
              label={t("settings.usage.credits")}
            />
            <div className="min-w-0">
              <p className="text-xs text-fg-muted">{t("settings.usage.credits")}</p>
              <p className="text-xl leading-tight font-medium text-fg tabular-nums">
                {creditsUnlimited
                  ? t("settings.usage.unlimited")
                  : t("settings.usage.creditsLeft", {
                      remaining: n(c.remaining ?? 0),
                      granted: n(c.granted ?? 0),
                    })}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-fg-muted">
                {c.reserved > 0 ? (
                  <span>{t("settings.usage.reserved", { count: n(c.reserved) })}</span>
                ) : null}
                {c.overage > 0 ? (
                  <span>{t("settings.usage.overage", { count: n(c.overage) })}</span>
                ) : null}
              </div>
              {c.throttled && nextPeriod ? (
                <p className="mt-2 text-sm text-accent-text">
                  {t("settings.usage.throttled", { date: formatDate(nextPeriod, locale) })}
                </p>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      ) : null}
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
        <Meter label={t("settings.usage.designs")} {...m.designs} format={n} />
        <Meter
          label={t("settings.usage.storage")}
          {...m.storageBytes}
          format={(v) => formatBytes(v, locale)}
        />
        <Meter label={t("settings.usage.exports")} {...m.exports} format={n} />
        <Meter label={t("settings.usage.brandKits")} {...m.brandKits} format={n} />
        <Meter label={t("settings.usage.workspaces")} {...m.workspaces} format={n} />
        <Meter label={t("settings.usage.aiRequests")} {...m.aiRequests} format={n} />
      </div>
      {summary.fairUse ? (
        <SettingsCard
          title={t("settings.usage.fairUse")}
          description={t("settings.billing.creditsBody")}
        >
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {[
              t("settings.usage.perMinute", { count: summary.fairUse.perMinuteAiRequests }),
              t("settings.usage.perDay", { count: summary.fairUse.perDayAiRequests }),
              t("settings.usage.concurrent", { count: summary.fairUse.maxConcurrentRuns }),
              ...(summary.fairUse.byokBypassesCredits ? [t("settings.usage.byok")] : []),
              ...(summary.fairUse.noOverageCharges ? [t("settings.usage.noOverage")] : []),
            ].map((line) => (
              <li key={line} className="flex items-center gap-2.5 text-sm text-fg-secondary">
                {line === t("settings.usage.noOverage") ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Gauge className="size-4 text-fg-muted" />
                )}
                {line}
              </li>
            ))}
          </ul>
        </SettingsCard>
      ) : null}
      {me.features["ai.agent"] ? <CreditHistory /> : null}
    </SettingsPage>
  );
}
