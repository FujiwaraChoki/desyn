import type { Metadata } from "next";
import Link from "next/link";
import { CtaBand } from "@/components/site/CtaBand";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";

export const metadata: Metadata = {
  title: "About",
  description: "Why Desyn exists and the principles it is built on.",
  alternates: { canonical: "/about" },
};

const PRINCIPLES = [
  {
    title: "Layers, not pictures",
    body: "An AI that hands you a flat image has done half the job. Desyn's AI works on the same layers you do, so its work is always yours to change.",
  },
  {
    title: "Restraint",
    body: "Good design is mostly what you leave out. We hold Desyn itself to that: calm type, one accent colour, no noise.",
  },
  {
    title: "Touch only what was asked",
    body: "When you ask for a change, nothing else moves. Every AI edit is one step you can undo.",
  },
  {
    title: "Fair pricing",
    body: "A useful free plan, one paid plan, no surprise overage. If you bring your own AI, you do not pay us for it.",
  },
  {
    title: "Your work stays yours",
    body: "Your designs belong to you, you can export them in open formats, and you can run all of Desyn on your own servers.",
  },
  {
    title: "Source you can read",
    body: "The whole product is source-available. You can see exactly what it does with your work.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title={
          <>
            Design should feel like <Em>light.</Em>
          </>
        }
      >
        Desyn started from a simple frustration: AI could draw pictures, but it could not design. It
        could not move a headline, keep a brand, or change one thing without changing everything. So
        we built an editor where it can.
      </PageHero>
      <section className="section pt-4" aria-labelledby="principles-title">
        <div className="container-wide">
          <h2 id="principles-title" className="label text-center">
            What we believe
          </h2>
          <div className="mx-auto mt-12 grid max-w-6xl gap-px overflow-hidden rounded-[24px] border border-fg/10 bg-fg/10 md:grid-cols-2 lg:grid-cols-3">
            {PRINCIPLES.map((p, i) => (
              <Reveal key={p.title} delay={(i % 3) * 0.06} className="bg-bg p-8 sm:p-10">
                <span className="font-mono text-[12px] text-sun-text">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-4 font-serif text-[30px] leading-tight">{p.title}</h3>
                <p className="mt-3 text-[15.5px] leading-7 text-fg/70">{p.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      <section className="section pt-0" aria-labelledby="who-title">
        <div className="container-content text-center">
          <Reveal>
            <h2 id="who-title" className="title">
              Who makes <Em>it.</Em>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="subhead mx-auto mt-6 max-w-xl">
              Desyn is made by Sami Hindi, together with everyone who contributes to the source. The{" "}
              <Link href="/legal/license" className="link">
                licence
              </Link>{" "}
              keeps the code open to read and free to self-host, while commercial rights pay for the
              work.
            </p>
          </Reveal>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
