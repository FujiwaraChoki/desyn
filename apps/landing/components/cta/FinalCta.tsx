import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Reveal } from "@/components/site/Reveal";
import { Em } from "@/components/site/SectionIntro";
import { SIGNUP_URL } from "@/lib/site";

export function FinalCta() {
  return (
    <section className="section" aria-labelledby="cta-title">
      <div className="flex flex-col items-center px-5 text-center">
        <Reveal>
          <h2
            id="cta-title"
            className="max-w-[14ch] font-serif text-[clamp(52px,7.4vw,118px)] leading-[0.95] tracking-[-0.02em]"
          >
            Make something <Em>beautiful</Em> before sunset.
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <p className="subhead mt-7 max-w-md">
            Start free in the browser, no card needed. Add the AI with Pro, or run all of it on your
            own server.
          </p>
        </Reveal>
        <Reveal delay={0.2}>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg group">
              Start designing — free
              <ArrowRight
                size={18}
                strokeWidth={1.75}
                className="transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </a>
            <Link href="/pricing" className="btn btn-secondary btn-lg">
              See pricing
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
