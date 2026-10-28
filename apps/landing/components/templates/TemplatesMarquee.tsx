import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { TEMPLATE_SPECS, type TemplateSpec } from "@/lib/templates";
import { TemplateArt } from "./TemplateArt";

function Card({ spec, copy }: { spec: TemplateSpec; copy: number }) {
  const [w, h] = spec.ratio;
  // Every card shares one height; width follows the template's own aspect ratio.
  return (
    <figure className="group relative mr-5 shrink-0">
      <div
        className="overflow-hidden rounded-[10px] shadow-[0_30px_60px_-30px_rgba(0,0,0,0.7)] ring-1 ring-fg/10 transition-transform duration-500 ease-[var(--ease-out)] group-hover:-translate-y-1.5"
        style={{ height: "var(--card-h)", width: `calc(var(--card-h) * ${w / h})` }}
      >
        <TemplateArt spec={spec} idSuffix={`-m${copy}`} className="block h-full w-full" />
      </div>
      <figcaption className="mt-3 text-[13px] text-subtle transition-colors group-hover:text-fg/85">
        {spec.title}
      </figcaption>
    </figure>
  );
}

function Row({
  specs,
  reverse,
  duration,
}: {
  specs: TemplateSpec[];
  reverse?: boolean;
  duration: string;
}) {
  return (
    <div className="marquee mask-fade-x overflow-hidden">
      <div
        className="marquee-track"
        data-reverse={reverse ? "true" : "false"}
        style={{ "--marquee-duration": duration } as React.CSSProperties}
      >
        {[0, 1].map((copy) => (
          <div key={copy} className="flex" aria-hidden={copy === 1 ? true : undefined}>
            {specs.map((s) => (
              <Card key={`${s.slug}-${copy}`} spec={s} copy={copy} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TemplatesMarquee() {
  const half = Math.ceil(TEMPLATE_SPECS.length / 2);
  return (
    <section className="section overflow-hidden" aria-labelledby="templates-title">
      <div className="container-wide">
        <SectionIntro
          id="templates-title"
          eyebrow="Templates"
          title={
            <>
              Start from something <Em>good.</Em>
            </>
          }
        >
          Hundreds of templates across posters, posts, decks, menus, invitations and more. Every one
          is real layers, so the AI can remix it for you.
        </SectionIntro>
      </div>
      <div className="mt-16 flex flex-col gap-8 [--card-h:220px] sm:[--card-h:280px]">
        <Row specs={TEMPLATE_SPECS.slice(0, half)} duration="80s" />
        <Row specs={TEMPLATE_SPECS.slice(half)} duration="95s" reverse />
      </div>
      <div className="mt-14 flex justify-center">
        <Link href="/templates" className="btn btn-secondary btn-md group">
          Browse templates
          <ArrowRight
            size={16}
            strokeWidth={1.5}
            className="transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>
    </section>
  );
}
