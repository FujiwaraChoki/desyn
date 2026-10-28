"use client";

import { Check, Minus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import type { PlanSummary } from "@/lib/plans";
import { SELF_HOST_DOCS_URL, SIGNUP_URL } from "@/lib/site";

type Interval = "month" | "year";

const BLURB: Record<PlanSummary["id"], string> = {
  free: "The full editor for personal projects. No AI.",
  pro: "Everything Desyn can do, with AI credits included.",
  selfhost: "Every feature on your own servers, for non-commercial use.",
};

function cta(id: PlanSummary["id"], interval: Interval) {
  if (id === "free") return { href: SIGNUP_URL, label: "Start free", external: true };
  if (id === "pro")
    return {
      href: `${SIGNUP_URL}?plan=pro&interval=${interval}`,
      label: "Get Pro",
      external: true,
    };
  return { href: SELF_HOST_DOCS_URL, label: "Read the self-hosting guide", external: true };
}

function Price({ plan, interval }: { plan: PlanSummary; interval: Interval }) {
  const yearly = interval === "year" && plan.priceYearly !== null;
  const amount = yearly ? plan.priceYearly : plan.priceMonthly;
  return (
    <div className="flex h-[92px] flex-col justify-end">
      <div className="flex items-baseline gap-2">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={`${plan.id}-${amount}`}
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(4px)" }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="font-serif text-[64px] leading-none tracking-[-0.02em]"
          >
            ${amount}
          </motion.span>
        </AnimatePresence>
        <span className="text-[15px] text-subtle">
          {plan.id === "selfhost"
            ? "forever"
            : plan.priceMonthly === 0
              ? "forever"
              : yearly
                ? "/ year"
                : "/ month"}
        </span>
      </div>
      <p className="mt-2 h-5 text-[13px] text-subtle">
        {plan.id === "pro" && plan.priceYearly !== null
          ? yearly
            ? `$${(plan.priceYearly / 12).toFixed(2)} a month, billed yearly`
            : `or $${plan.priceYearly} a year`
          : plan.id === "selfhost"
            ? "Non-commercial licence"
            : "No card needed"}
      </p>
    </div>
  );
}

export function PricingCards({
  plans,
  savingsMonths,
  maxLines = 9,
  showComparisonLink = true,
}: {
  plans: PlanSummary[];
  savingsMonths: number;
  maxLines?: number;
  showComparisonLink?: boolean;
}) {
  const [interval, setBilling] = useState<Interval>("month");
  return (
    <div>
      <div className="flex justify-center">
        <fieldset className="relative inline-flex rounded-full border border-fg/10 bg-surface-1/70 p-1 min-w-0">
          <legend className="sr-only">Billing interval</legend>
          {(["month", "year"] as const).map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={interval === i}
              onClick={() => setBilling(i)}
              className={`relative z-10 flex h-10 items-center gap-2 rounded-full px-5 text-[14px] transition-colors ${interval === i ? "text-on-sun" : "text-fg/65 hover:text-fg"}`}
            >
              {interval === i && (
                <motion.span
                  layoutId="interval-pill"
                  className="absolute inset-0 -z-10 rounded-full bg-sun"
                  transition={{ type: "spring", stiffness: 400, damping: 34 }}
                />
              )}
              {i === "month" ? "Monthly" : "Yearly"}
              {i === "year" && savingsMonths > 0 && (
                <span
                  className={`text-[12px] ${interval === i ? "text-on-sun/70" : "text-sun-text"}`}
                >
                  {savingsMonths} months free
                </span>
              )}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="mt-12 grid items-stretch gap-5 lg:grid-cols-3">
        {plans.map((plan) => {
          const featured = plan.id === "pro";
          const action = cta(plan.id, interval);
          const lines = plan.lines.slice(0, maxLines);
          const more = plan.lines.length - lines.length;
          return (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-[24px] p-8 ${
                featured
                  ? "bg-surface-1 ring-1 ring-sun/40"
                  : "bg-surface-1/50"
              }`}
            >
              <div className="relative flex items-center justify-between">
                <h3 className="font-serif text-[30px] leading-none">{plan.name}</h3>
                {featured && <span className="pill pill-pro">Pro</span>}
              </div>
              <p className="relative mt-3 min-h-12 text-[14.5px] leading-6 text-fg/65">
                {BLURB[plan.id]}
              </p>
              <div className="relative">
                <Price plan={plan} interval={interval} />
              </div>
              {action.external ? (
                <a
                  href={action.href}
                  className={`btn btn-md relative mt-7 w-full ${featured ? "btn-primary" : "btn-secondary"}`}
                >
                  {action.label}
                </a>
              ) : (
                <Link href={action.href} className="btn btn-md btn-secondary relative mt-7 w-full">
                  {action.label}
                </Link>
              )}
              <ul className="relative mt-8 flex flex-col gap-3 border-t border-fg/[0.08] pt-7">
                {lines.map((l) => (
                  <li
                    key={l.text}
                    className={`flex items-start gap-3 text-[14.5px] leading-6 ${l.included ? "text-fg/80" : "text-subtle"}`}
                  >
                    {l.included ? (
                      <Check
                        size={16}
                        strokeWidth={1.75}
                        className="mt-1 shrink-0 text-sun"
                        aria-hidden="true"
                      />
                    ) : (
                      <Minus
                        size={16}
                        strokeWidth={1.5}
                        className="mt-1 shrink-0 text-subtle"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      <span className="sr-only">
                        {l.included ? "Included: " : "Not included: "}
                      </span>
                      {l.text}
                    </span>
                  </li>
                ))}
                {more > 0 && <li className="pl-7 text-[13.5px] text-subtle">and {more} more</li>}
              </ul>
            </div>
          );
        })}
      </div>
      {showComparisonLink && (
        <p className="mt-10 text-center text-[14px] text-subtle">
          Prices in US dollars. Fair use applies to AI credits.{" "}
          <Link href="/pricing#compare" className="link">
            Compare every feature
          </Link>
        </p>
      )}
    </div>
  );
}
