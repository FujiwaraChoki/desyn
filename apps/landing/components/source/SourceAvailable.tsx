import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { GITHUB_URL, SELF_HOST_DOCS_URL } from "@/lib/site";

const TERMS = [
  { can: true, text: "Read, run and modify every line of the source" },
  {
    can: true,
    text: "Self-host it with every feature, free, for personal, educational and non-profit use",
  },
  { can: true, text: "Contribute improvements back" },
  {
    can: false,
    text: "Use it commercially, host it as a service or sell it without a commercial licence",
  },
];

export function SourceAvailable() {
  return (
    <section className="section" aria-labelledby="source-title">
      <div className="container-wide">
        <div className="relative overflow-hidden rounded-[32px] border border-fg/10 bg-surface-1/60 px-6 py-16 sm:px-14 sm:py-20">
          <div className="orb orb-float-1 -right-32 -top-40 size-[480px]" aria-hidden="true" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgb(var(--fg-rgb))_1px,transparent_1px),linear-gradient(90deg,rgb(var(--fg-rgb))_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_70%_30%,#000,transparent_70%)]"
          />
          <div className="relative grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <Reveal>
                <p className="label">Source available</p>
              </Reveal>
              <Reveal delay={0.08}>
                <h2 id="source-title" className="title mt-5">
                  Open to <Em>read.</Em>
                  <br />
                  Yours to run.
                </h2>
              </Reveal>
              <Reveal delay={0.16}>
                <p className="subhead mt-6 max-w-lg">
                  Desyn is source-available, free for non-commercial use. Every line is public under the
                  Desyn Non-Commercial Source License. Commercial use needs a licence from us, and
                  that is what pays for the work.
                </p>
              </Reveal>
              <Reveal delay={0.22}>
                <div className="mt-8 flex flex-wrap gap-3">
                  {GITHUB_URL ? (
                    <a href={GITHUB_URL} rel="noopener" className="btn btn-primary btn-md">
                      View the source{" "}
                      <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
                    </a>
                  ) : null}
                  <Link href="/legal/license" className="btn btn-secondary btn-md">
                    The licence in plain words
                  </Link>
                  <a href={SELF_HOST_DOCS_URL} className="btn btn-ghost btn-md">
                    Self-hosting guide
                  </a>
                </div>
              </Reveal>
            </div>
            <Reveal delay={0.12}>
              <ul className="flex flex-col divide-y divide-fg/[0.08] rounded-[20px] border border-fg/10 bg-bg/50 backdrop-blur">
                {TERMS.map((t) => (
                  <li key={t.text} className="flex items-start gap-4 px-6 py-5">
                    <span
                      className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[13px] ${
                        t.can ? "bg-sun/15 text-sun-text" : "bg-fg/[0.06] text-subtle"
                      }`}
                      aria-hidden="true"
                    >
                      {t.can ? "✓" : "×"}
                    </span>
                    <span
                      className={`text-[15px] leading-6 ${t.can ? "text-fg/85" : "text-fg/60"}`}
                    >
                      <span className="sr-only">{t.can ? "You can: " : "You cannot: "}</span>
                      {t.text}
                    </span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
