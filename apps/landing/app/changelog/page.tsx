import type { Metadata } from "next";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { CHANGELOG } from "@/lib/content/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every Desyn release: what changed and why.",
  alternates: { canonical: "/changelog" },
};

export default function ChangelogPage() {
  return (
    <>
      <PageHero
        eyebrow="Changelog"
        title={
          <>
            What is <Em>new.</Em>
          </>
        }
      >
        Every release, in plain words.
      </PageHero>
      <section className="pb-24" aria-label="Releases">
        <div className="container-wide">
          <ol className="relative mx-auto max-w-3xl border-l border-fg/10 pl-8 sm:pl-12">
            {CHANGELOG.map((e) => (
              <Reveal as="li" key={`${e.version}-${e.date}`} className="relative pb-16">
                <span
                  className="absolute -left-[37px] top-2 size-[9px] rounded-full bg-sun sm:-left-[53px]"
                  aria-hidden="true"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <span className="pill">{e.version}</span>
                  <time className="text-[14px] text-subtle">{e.date}</time>
                </div>
                <h2 className="mt-5 font-serif text-[clamp(32px,3.4vw,46px)] leading-[1.05]">
                  {e.title}
                </h2>
                <p className="body mt-4">{e.summary}</p>
                <ul className="mt-6 flex flex-col gap-3">
                  {e.items.map((item) => (
                    <li key={item} className="flex gap-3 text-[15.5px] leading-7 text-fg/75">
                      <span className="mt-[11px] size-1.5 shrink-0 rounded-full bg-sun/80" />
                      {item}
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
