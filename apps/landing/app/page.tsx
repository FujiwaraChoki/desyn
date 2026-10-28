import { Capabilities } from "@/components/capabilities/Capabilities";
import { FinalCta } from "@/components/cta/FinalCta";
import { LiveDemo } from "@/components/demo/LiveDemo";
import { FaqSection } from "@/components/faq/FaqSection";
import { Hero } from "@/components/hero/Hero";
import { LayerStack } from "@/components/layers/LayerStack";
import { Platforms } from "@/components/platforms/Platforms";
import { PricingSection } from "@/components/pricing/PricingSection";
import { Providers } from "@/components/providers/Providers";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { SourceAvailable } from "@/components/source/SourceAvailable";
import { TemplatesMarquee } from "@/components/templates/TemplatesMarquee";

export default function HomePage() {
  return (
    <>
      <Hero />
      <section id="demo" className="section pt-16 md:pt-24" aria-labelledby="demo-title">
        <div className="container-wide">
          <SectionIntro
            id="demo-title"
            eyebrow="Live demo"
            title={
              <>
                Watch it build. Then <Em>talk</Em> to it.
              </>
            }
          >
            Type what you need or pick a suggestion. Desyn lays down real layers one by one, then
            restyles them when you ask. Click a layer, drag it, hide it.
          </SectionIntro>
          <div className="mt-14">
            <LiveDemo />
          </div>
        </div>
      </section>
      <section aria-label="Not a picture. Layers.">
        <LayerStack />
      </section>
      <Capabilities />
      <TemplatesMarquee />
      <Platforms />
      <Providers />
      <PricingSection />
      <SourceAvailable />
      <FaqSection />
      <FinalCta />
    </>
  );
}
