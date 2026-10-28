import { Check, Minus } from "lucide-react";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq/Faq";
import { PricingCards } from "@/components/pricing/PricingCards";
import { CtaBand } from "@/components/site/CtaBand";
import { JsonLd } from "@/components/site/JsonLd";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { FAQ } from "@/lib/content/faq";
import { faqJsonLd } from "@/lib/jsonld";
import {
  comparisonRows,
  creditCostRows,
  planConfig,
  planSummaries,
  yearlySavingsMonths,
} from "@/lib/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Free for the editor, $${planConfig.plans.pro.priceMonthly} a month for everything with AI, and free to self-host for non-commercial use.`,
  alternates: { canonical: "/pricing" },
};

const PLAN_IDS = ["free", "pro", "selfhost"] as const;

function Cell({ value }: { value: string | boolean }) {
  if (value === true)
    return (
      <Check
        size={17}
        strokeWidth={1.75}
        className="mx-auto text-sun"
        role="img"
        aria-label="Included"
      />
    );
  if (value === false)
    return (
      <Minus
        size={17}
        strokeWidth={1.5}
        className="mx-auto text-subtle"
        role="img"
        aria-label="Not included"
      />
    );
  return <span className="text-fg/80">{value}</span>;
}

export default function PricingPage() {
  const plans = planSummaries();
  const { limits, features } = comparisonRows();
  const fair = planConfig.fairUse;
  const faq = FAQ.filter((f) => /free|Pro|credits|own AI|company/i.test(f.q));

  return (
    <>
      <JsonLd data={faqJsonLd(faq)} />
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            Pay for the <Em>AI.</Em> Not for the basics.
          </>
        }
      >
        The editor is free. Pro adds the AI and everything else for one price. Self-host the whole
        thing free for non-commercial use.
      </PageHero>

      <section className="pb-12" aria-labelledby="plans-title">
        <div className="container-wide">
          <h2 id="plans-title" className="sr-only">
            Plans
          </h2>
          <PricingCards
            plans={plans}
            savingsMonths={yearlySavingsMonths("pro")}
            maxLines={40}
            showComparisonLink={false}
          />
        </div>
      </section>

      <section id="compare" className="section" aria-labelledby="compare-title">
        <div className="container-wide">
          <SectionIntro
            id="compare-title"
            eyebrow="Compare"
            title={
              <>
                Every limit, <Em>side by side.</Em>
              </>
            }
          >
            Generated from the same configuration the app enforces, so this table is always the
            truth.
          </SectionIntro>
          <Reveal className="mt-14 overflow-hidden rounded-[22px] border border-fg/10">
            <section
              aria-label="Plan comparison"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: scrolls sideways on phones, so keyboard users must be able to focus it (WCAG 2.1.1).
              tabIndex={0}
              className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sun"
            >
              <table className="w-full min-w-[640px] border-collapse text-[14.5px]">
                <caption className="sr-only">Plan comparison</caption>
                <thead>
                  <tr className="bg-surface-1">
                    <th scope="col" className="w-[40%] px-6 py-5 text-left font-normal text-subtle">
                      Plan
                    </th>
                    {plans.map((p) => (
                      <th
                        key={p.id}
                        scope="col"
                        className={`px-4 py-5 text-center font-serif text-[22px] font-normal ${p.id === "pro" ? "text-sun-text" : ""}`}
                      >
                        {p.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={4}
                      className="label bg-bg px-6 pb-2 pt-8 text-left text-[11px] font-normal"
                    >
                      Limits
                    </th>
                  </tr>
                  {limits.map((r) => (
                    <tr key={r.label} className="border-t border-fg/[0.07]">
                      <th scope="row" className="px-6 py-3.5 text-left font-normal text-fg/70">
                        {r.label}
                      </th>
                      {PLAN_IDS.map((id) => (
                        <td key={id} className="px-4 py-3.5 text-center">
                          <Cell value={r.values[id]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={4}
                      className="label bg-bg px-6 pb-2 pt-10 text-left text-[11px] font-normal"
                    >
                      Features
                    </th>
                  </tr>
                  {features.map((r) => (
                    <tr key={r.label} className="border-t border-fg/[0.07]">
                      <th scope="row" className="px-6 py-3.5 text-left font-normal text-fg/70">
                        {r.label}
                      </th>
                      {PLAN_IDS.map((id) => (
                        <td key={id} className="px-4 py-3.5 text-center">
                          <Cell value={r.values[id]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </Reveal>
        </div>
      </section>

      <section className="section pt-0" aria-labelledby="credits-title">
        <div className="container-wide grid gap-14 lg:grid-cols-2">
          <div>
            <SectionIntro
              id="credits-title"
              align="left"
              eyebrow="AI credits"
              title={
                <>
                  What a credit <Em>buys.</Em>
                </>
              }
            >
              Pro includes {planConfig.plans.pro.limits.creditsPerMonth} credits every month.
              Requests made with your own API keys or local models never use credits.
            </SectionIntro>
            <Reveal delay={0.2}>
              <ul className="mt-10 flex flex-col gap-4 text-[15px] leading-6 text-fg/70">
                <li className="flex gap-3">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sun" />
                  {fair.noOverageCharges ? "No overage charges, ever." : "Overage is billed."} When
                  credits run out, AI requests slow down (a short wait between requests) until the
                  next month.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sun" />
                  Fair use keeps the service fast for everyone: up to {fair.perMinuteAiRequests} AI
                  requests a minute, {fair.perDayAiRequests} a day and {fair.maxConcurrentRuns} runs
                  at once.
                </li>
                <li className="flex gap-3">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sun" />
                  Credits reset monthly and do not roll over.
                </li>
              </ul>
            </Reveal>
          </div>
          <Reveal delay={0.1}>
            <div className="overflow-hidden rounded-[22px] border border-fg/10">
              <table className="w-full border-collapse text-[14.5px]">
                <caption className="sr-only">Credit cost per AI action</caption>
                <thead>
                  <tr className="bg-surface-1">
                    <th scope="col" className="px-6 py-4 text-left font-normal text-subtle">
                      Action
                    </th>
                    <th scope="col" className="px-6 py-4 text-right font-normal text-subtle">
                      Credits
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {creditCostRows().map((r) => (
                    <tr key={r.label} className="border-t border-fg/[0.07]">
                      <td className="px-6 py-3 text-fg/75">{r.label}</td>
                      <td className="px-6 py-3 text-right font-mono text-fg">{r.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section pt-0" aria-labelledby="pricing-faq-title">
        <div className="container-wide grid gap-14 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionIntro
            id="pricing-faq-title"
            align="left"
            eyebrow="Questions"
            title={
              <>
                About <Em>paying.</Em>
              </>
            }
          />
          <FaqList items={faq} />
        </div>
      </section>
      <CtaBand />
    </>
  );
}
