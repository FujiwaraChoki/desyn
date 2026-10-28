"use client";

import { PLANS } from "@desyn/schema/plans";
import { Badge, Button, Callout, cn, ProBadge, SegmentedControl, Skeleton, toast } from "@desyn/ui";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowUpRight, Check, ExternalLink } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { track } from "@/lib/analytics";
import { datafastAttribution } from "@/lib/attribution";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { SettingsCard, SettingsPage } from "./settings-ui";

type Interval = "month" | "year";

function Feature({ children }: { children: string }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-fg-secondary">
      <Check className="mt-0.5 size-4 shrink-0 text-accent" />
      {children}
    </li>
  );
}

export function CreditHistory() {
  const t = useT();
  const locale = useLocale();
  const { results, status, loadMore } = usePaginatedQuery(
    api.billing.credits.history,
    {},
    { initialNumItems: 10 },
  );
  return (
    <SettingsCard title={t("settings.billing.history")}>
      {status === "LoadingFirstPage" ? (
        <Skeleton className="h-24" />
      ) : results.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("settings.billing.noHistory")}</p>
      ) : (
        <>
          <ul className="divide-y divide-line-subtle">
            {results.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {t(`settings.billing.reasons.${e.reason}` as "settings.billing.reasons.grant")}
                    {e.kind ? <span className="text-fg-muted"> · {e.kind}</span> : null}
                  </span>
                  <span className="block text-2xs text-fg-muted">
                    {formatDateTime(e.createdAt, locale)}
                  </span>
                </span>
                <span
                  className={cn(
                    "font-mono text-sm tabular-nums",
                    e.delta >= 0 ? "text-success" : "text-fg",
                  )}
                >
                  {e.delta >= 0 ? "+" : ""}
                  {formatNumber(e.delta, locale)}
                </span>
                <span className="w-16 text-right font-mono text-xs text-fg-muted tabular-nums">
                  {e.balanceAfter === null ? "∞" : formatNumber(e.balanceAfter, locale)}
                </span>
              </li>
            ))}
          </ul>
          {status === "CanLoadMore" ? (
            <Button variant="ghost" size="sm" className="self-center" onClick={() => loadMore(20)}>
              {t("dashboard.filters.loadMore")}
            </Button>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}

export function BillingSettings() {
  const t = useT();
  const locale = useLocale();
  const params = useSearchParams();
  const { me } = useApp();
  const status = useQuery(api.billing.subscription.status, {});
  const checkout = useAction(api.billing.stripeActions.createCheckout);
  const portal = useAction(api.billing.stripeActions.createPortal);
  const [interval, setInterval] = useState<Interval>(
    params.get("interval") === "year" ? "year" : "month",
  );
  const [pending, setPending] = useState<"checkout" | "portal" | null>(null);
  const highlight = params.get("upgrade") === "1";
  const result = params.get("checkout");

  useEffect(() => {
    if (result === "success") track("checkout_completed", {});
  }, [result]);

  const startCheckout = async () => {
    setPending("checkout");
    try {
      const attribution = datafastAttribution(document.cookie);
      const { url } = await checkout({
        interval,
        returnPath: "/settings/billing",
        ...(attribution ? { attribution } : {}),
      });
      track("checkout_started", { interval });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(null);
    }
  };

  const openPortal = async () => {
    setPending("portal");
    try {
      const { url } = await portal({ returnPath: "/settings/billing" });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorMessage(error));
      setPending(null);
    }
  };

  if (status === undefined) {
    return (
      <SettingsPage
        title={t("settings.billing.title")}
        description={t("settings.billing.subtitle")}
      >
        <Skeleton className="h-72 rounded-panel" />
      </SettingsPage>
    );
  }
  if (!status.enabled) {
    return (
      <SettingsPage
        title={t("settings.billing.title")}
        description={t("settings.billing.subtitle")}
      >
        <Callout tone="info">{t("settings.billing.disabled")}</Callout>
      </SettingsPage>
    );
  }

  const pro = PLANS.plans.pro;
  const free = PLANS.plans.free;
  const isPro = status.plan === "pro";
  const sub = status.subscription;
  const yearly = pro.priceYearly ?? pro.priceMonthly * 12;
  const price = interval === "year" ? yearly : pro.priceMonthly;
  const yearlyAvailable = status.prices.yearly.available;

  return (
    <SettingsPage title={t("settings.billing.title")} description={t("settings.billing.subtitle")}>
      {result === "success" ? (
        <Callout tone="success">
          {isPro ? t("settings.billing.success") : t("settings.billing.successPending")}
        </Callout>
      ) : null}
      {result === "canceled" ? (
        <Callout tone="info">{t("settings.billing.canceled")}</Callout>
      ) : null}
      {sub?.status === "past_due" ? (
        <Callout tone="danger">{t("settings.billing.pastDue")}</Callout>
      ) : null}
      {status.overridden ? <Callout tone="info">{t("settings.billing.overridden")}</Callout> : null}

      {!isPro && yearlyAvailable ? (
        <div className="flex items-center gap-3">
          <SegmentedControl
            options={[
              { value: "month", label: t("settings.billing.monthly") },
              { value: "year", label: t("settings.billing.yearly") },
            ]}
            value={interval}
            onValueChange={setInterval}
          />
          <Badge tone="accent">{t("settings.billing.save")}</Badge>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col rounded-panel bg-fg/[0.03] p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-medium text-fg">{free.name}</h3>
            {!isPro ? <Badge>{t("settings.billing.current")}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-fg-muted">{t("settings.billing.free.tagline")}</p>
          <p className="mt-4 text-2xl leading-none font-medium text-fg tabular-nums">
            {formatCurrency(0, PLANS.currency, locale)}
            <span className="ml-1 text-sm font-normal text-fg-muted">
              {t("settings.billing.perMonth")}
            </span>
          </p>
          <ul className="mt-4 flex flex-col gap-2">
            <Feature>
              {t("settings.billing.free.f1", { designs: free.limits.designs ?? "∞" })}
            </Feature>
            <Feature>{t("settings.billing.free.f2")}</Feature>
            <Feature>{t("settings.billing.free.f3")}</Feature>
            <Feature>{t("settings.billing.free.f4")}</Feature>
          </ul>
        </section>
        <section
          className={cn(
            "flex flex-col rounded-panel bg-fg/[0.03] p-5",
            highlight && !isPro && "ring-1 ring-accent/50",
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-medium text-fg">
              {pro.name} <ProBadge />
            </h3>
            {isPro ? <Badge tone="accent">{t("settings.billing.current")}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-fg-muted">{t("settings.billing.pro.tagline")}</p>
          <p className="mt-4 text-2xl leading-none font-medium text-fg tabular-nums">
            {formatCurrency(price, PLANS.currency, locale)}
            <span className="ml-1 text-sm font-normal text-fg-muted">
              {interval === "year" ? t("settings.billing.perYear") : t("settings.billing.perMonth")}
            </span>
          </p>
          <ul className="mt-4 flex flex-col gap-2">
            <Feature>
              {t("settings.billing.pro.f1", {
                credits: formatNumber(pro.limits.creditsPerMonth ?? 0, locale),
              })}
            </Feature>
            <Feature>{t("settings.billing.pro.f2")}</Feature>
            <Feature>{t("settings.billing.pro.f3")}</Feature>
            <Feature>{t("settings.billing.pro.f4")}</Feature>
            <Feature>{t("settings.billing.pro.f5")}</Feature>
          </ul>
          <div className="mt-6 flex flex-col gap-2">
            {isPro ? (
              sub ? (
                <p className="text-sm text-fg-secondary">
                  <Badge
                    tone={
                      sub.status === "active" || sub.status === "trialing" ? "success" : "warning"
                    }
                    className="mr-2"
                  >
                    {t(`settings.billing.status.${sub.status}` as "settings.billing.status.active")}
                  </Badge>
                  {sub.currentPeriodEnd
                    ? sub.cancelAtPeriodEnd
                      ? t("settings.billing.ends", {
                          date: formatDate(sub.currentPeriodEnd, locale),
                        })
                      : t("settings.billing.renews", {
                          date: formatDate(sub.currentPeriodEnd, locale),
                        })
                    : null}
                </p>
              ) : null
            ) : (
              <Button
                variant="primary"
                leadingIcon={<ArrowUpRight />}
                loading={pending === "checkout"}
                disabled={
                  pending !== null ||
                  !(interval === "year" ? yearlyAvailable : status.prices.monthly.available)
                }
                onClick={startCheckout}
              >
                {t("settings.billing.upgrade")}
              </Button>
            )}
          </div>
        </section>
      </div>

      {status.hasCustomer || isPro ? (
        <SettingsCard
          title={t("settings.billing.manage")}
          description={t("settings.billing.manageBody")}
          footer={
            <Button
              variant="secondary"
              trailingIcon={<ExternalLink />}
              loading={pending === "portal"}
              onClick={openPortal}
            >
              {t("settings.billing.manage")}
            </Button>
          }
        />
      ) : null}

      {me.features["ai.agent"] ? <CreditHistory /> : null}
    </SettingsPage>
  );
}
