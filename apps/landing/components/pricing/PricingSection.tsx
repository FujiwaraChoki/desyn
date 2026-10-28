import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { planSummaries, yearlySavingsMonths } from "@/lib/plans";
import { PricingCards } from "./PricingCards";

export function PricingSection() {
  return (
    <section id="pricing" className="section relative" aria-labelledby="pricing-title">
      <div
        className="orb orb-float-3 left-1/2 top-[40%] size-[640px] -translate-x-1/2"
        aria-hidden="true"
      />
      <div className="container-wide relative">
        <SectionIntro
          id="pricing-title"
          eyebrow="Pricing"
          title={
            <>
              Simple, and <Em>fair.</Em>
            </>
          }
        >
          A free plan for the editor, one paid plan for everything, and the whole thing free on your
          own servers for non-commercial use.
        </SectionIntro>
        <div className="mt-14">
          <PricingCards plans={planSummaries()} savingsMonths={yearlySavingsMonths("pro")} />
        </div>
      </div>
    </section>
  );
}
