import { JsonLd } from "@/components/site/JsonLd";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { FAQ } from "@/lib/content/faq";
import { faqJsonLd } from "@/lib/jsonld";
import { CONTACT_EMAIL } from "@/lib/site";
import { FaqList } from "./Faq";

export function FaqSection() {
  return (
    <section className="section" aria-labelledby="faq-title">
      <JsonLd data={faqJsonLd(FAQ)} />
      <div className="container-wide grid gap-14 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <SectionIntro
            id="faq-title"
            align="left"
            eyebrow="Questions"
            title={
              <>
                Asked, <Em>answered.</Em>
              </>
            }
          >
            Something missing? Write to <span className="text-fg">{CONTACT_EMAIL}</span>.
          </SectionIntro>
        </div>
        <FaqList items={FAQ} />
      </div>
    </section>
  );
}
