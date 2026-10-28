import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Vignette } from "@/components/capabilities/Vignettes";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { CAPABILITIES } from "@/lib/content/capabilities";
import { FEATURES } from "@/lib/content/features";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Generate designs, edit by talking, brand memory, workflows, collaboration and self-hosting: everything Desyn does.",
  alternates: { canonical: "/features" },
};

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title={
          <>
            Everything it takes to <Em>make</Em> it.
          </>
        }
      >
        A complete design editor with an AI that works on real layers, on the web, on your desktop
        and on your phone.
      </PageHero>

      <section className="section pt-4" aria-label="What the AI does">
        <div className="container-wide grid gap-x-8 gap-y-16 md:grid-cols-2">
          {CAPABILITIES.map((c, i) => (
            <Reveal key={c.id} delay={(i % 2) * 0.08}>
              <article>
                <Vignette id={c.id} />
                <div className="mt-6 flex items-center gap-3">
                  <span className="font-mono text-[12px] text-sun-text">{c.index}</span>
                  <span className="label text-[11px]">{c.label}</span>
                </div>
                <h2 className="mt-3 font-serif text-[clamp(30px,3vw,40px)] leading-[1.05]">
                  {c.title[0]}
                  <Em>{c.title[1]}</Em>
                  {c.title[2]}
                </h2>
                <p className="body mt-3 max-w-lg">{c.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section pt-0" aria-labelledby="deeper-title">
        <div className="container-wide">
          <SectionIntro
            id="deeper-title"
            eyebrow="Go deeper"
            title={
              <>
                One page for <Em>each.</Em>
              </>
            }
          />
          <div className="mt-14 grid gap-px overflow-hidden rounded-[24px] border border-fg/10 bg-fg/10 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Link
                key={f.slug}
                href={`/features/${f.slug}`}
                className="group flex min-h-[220px] flex-col bg-bg p-8 transition-colors hover:bg-surface-1"
              >
                <span className="label text-[11px]">{f.eyebrow}</span>
                <h3 className="mt-4 font-serif text-[30px] leading-tight">{f.nav}</h3>
                <p className="mt-3 text-[15px] leading-6 text-fg/65">{f.summary}</p>
                <span className="mt-auto flex items-center gap-2 pt-6 text-[14px] text-fg/70 transition-colors group-hover:text-sun-text">
                  Read more{" "}
                  <ArrowRight
                    size={15}
                    strokeWidth={1.5}
                    className="transition-transform group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
