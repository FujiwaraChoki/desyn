import { ArrowRight, Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FeatureVisual } from "@/components/features/FeatureVisual";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { FEATURES, featureBySlug } from "@/lib/content/features";
import { SELF_HOST_DOCS_URL, SIGNUP_URL } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const f = featureBySlug((await params).slug);
  if (!f) return {};
  return { title: f.nav, description: f.summary, alternates: { canonical: `/features/${f.slug}` } };
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
  const f = featureBySlug((await params).slug);
  if (!f) notFound();
  const selfHost = f.slug === "self-hosting";
  const others = FEATURES.filter((x) => x.slug !== f.slug);

  return (
    <>
      <PageHero
        eyebrow={f.eyebrow}
        title={
          <>
            {f.title[0]}
            <Em>{f.title[1]}</Em>
            {f.title[2]}
          </>
        }
        actions={
          selfHost ? (
            <>
              <a href={SELF_HOST_DOCS_URL} className="btn btn-primary btn-lg">
                Read the self-hosting guide
              </a>
              <Link href="/legal/license" className="btn btn-secondary btn-lg">
                The licence
              </Link>
            </>
          ) : (
            <>
              <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                Start designing — free
              </a>
              <Link href="/pricing" className="btn btn-secondary btn-lg">
                Pricing
              </Link>
            </>
          )
        }
      >
        {f.intro}
      </PageHero>

      <section className="pb-8" aria-label="Overview">
        <div className="container-wide">
          <Reveal className="mx-auto max-w-4xl">
            <FeatureVisual visual={f.visual} />
          </Reveal>
          <Reveal
            className="mx-auto mt-8 flex max-w-3xl items-start gap-3 rounded-[14px] border border-fg/10 bg-surface-1/60 px-5 py-4 text-[14.5px] leading-6 text-fg/70"
            delay={0.1}
          >
            <Check
              size={16}
              strokeWidth={1.75}
              className="mt-1 shrink-0 text-sun"
              aria-hidden="true"
            />
            <p>
              <span className="text-fg">Availability.</span> {f.availability}
            </p>
          </Reveal>
        </div>
      </section>

      <section className="section" aria-label="Details">
        <div className="container-wide flex flex-col gap-24 md:gap-32">
          {f.sections.map((s, i) => {
            // The page's own visual is already shown above; do not repeat it next to a section.
            const visual = s.visual && s.visual !== f.visual ? s.visual : undefined;
            return (
              <div
                key={s.title}
                className={`grid items-center gap-10 ${visual ? "lg:grid-cols-2 lg:gap-20" : "mx-auto max-w-3xl"}`}
              >
                <Reveal className={visual && i % 2 === 1 ? "lg:order-2" : ""}>
                  <span className="font-mono text-[12px] text-sun-text">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h2 className="mt-3 font-serif text-[clamp(34px,3.6vw,52px)] leading-[1.04]">
                    {s.title}
                  </h2>
                  <p className="body mt-5 max-w-xl text-[17px]">{s.body}</p>
                  {s.points ? (
                    <ul className="mt-6 flex flex-col gap-2.5">
                      {s.points.map((p) => (
                        <li key={p} className="flex items-start gap-3 text-[15px] text-fg/70">
                          <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-sun/80" />
                          {p}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Reveal>
                {visual ? (
                  <Reveal delay={0.1}>
                    <FeatureVisual visual={visual} />
                  </Reveal>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section pt-0" aria-labelledby="more-title">
        <div className="container-wide">
          <h2 id="more-title" className="label">
            More features
          </h2>
          <div className="mt-6 grid gap-px overflow-hidden rounded-[20px] border border-fg/10 bg-fg/10 sm:grid-cols-2 lg:grid-cols-5">
            {others.map((o) => (
              <Link
                key={o.slug}
                href={`/features/${o.slug}`}
                className="group flex flex-col bg-bg p-6 transition-colors hover:bg-surface-1"
              >
                <span className="font-serif text-[22px] leading-tight">{o.nav}</span>
                <span className="mt-2 text-[13.5px] leading-5 text-subtle">{o.summary}</span>
                <ArrowRight
                  size={15}
                  strokeWidth={1.5}
                  className="mt-4 text-subtle transition-all group-hover:translate-x-1 group-hover:text-sun"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
