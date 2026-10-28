"use client";

import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useInView } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { CAPABILITIES, type Capability } from "@/lib/content/capabilities";
import { Vignette } from "./Vignettes";

function Title({ c }: { c: Capability }) {
  return (
    <>
      {c.title[0]}
      <Em>{c.title[1]}</Em>
      {c.title[2]}
    </>
  );
}

function Step({ c, onActive }: { c: Capability; onActive: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Active while the block crosses the middle band of the viewport.
  const active = useInView(ref, { margin: "-45% 0px -45% 0px" });
  useEffect(() => {
    if (active) onActive();
  }, [active, onActive]);
  return (
    <div ref={ref} className="flex flex-col justify-center py-14 lg:min-h-[78vh] lg:py-0">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[12px] text-sun-text">{c.index}</span>
        <span className="h-px w-8 bg-fg/20" />
        <span className="label text-[11px]">{c.label}</span>
      </div>
      <h3 className="mt-5 font-serif text-[clamp(36px,4.2vw,60px)] leading-[1.02] tracking-[-0.01em]">
        <Title c={c} />
      </h3>
      <p className="body mt-5 max-w-md text-[17px]">{c.body}</p>
      <ul className="mt-6 flex flex-col gap-2.5">
        {c.points.map((p) => (
          <li key={p} className="flex items-start gap-3 text-[15px] text-fg/70">
            <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-sun/80" />
            {p}
          </li>
        ))}
      </ul>
      <Link
        href={c.href}
        className="link mt-7 inline-flex w-fit items-center gap-2 text-[15px] no-underline"
      >
        Learn more <ArrowRight size={15} strokeWidth={1.5} aria-hidden="true" />
      </Link>
      <div className="mt-10 lg:hidden">
        <Vignette id={c.id} />
      </div>
    </div>
  );
}

export function Capabilities() {
  const [active, setActive] = useState(0);
  return (
    <section className="section relative" aria-labelledby="capabilities-title">
      <div className="orb orb-float-2 -left-40 top-[30%] size-[520px]" aria-hidden="true" />
      <div className="container-wide relative">
        <SectionIntro
          id="capabilities-title"
          eyebrow="What the AI does"
          title={
            <>
              A designer that <Em>listens.</Em>
            </>
          }
        >
          Six things Desyn does on your canvas, on real layers, in plain language.
        </SectionIntro>

        <div className="mt-10 grid gap-x-20 lg:mt-16 lg:grid-cols-[1fr_1.15fr]">
          <div>
            {CAPABILITIES.map((c, i) => (
              <Step key={c.id} c={c} onActive={() => setActive(i)} />
            ))}
          </div>
          <div className="relative hidden lg:block">
            <div className="sticky top-[14vh] flex h-[72vh] items-center">
              <div className="relative w-full">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={CAPABILITIES[active]?.id}
                    initial={{ opacity: 0, y: 24, scale: 0.98, filter: "blur(6px)" }}
                    animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -16, scale: 0.98, filter: "blur(6px)" }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Vignette id={CAPABILITIES[active]?.id ?? "generate"} />
                  </motion.div>
                </AnimatePresence>
                <div className="mt-6 flex items-center justify-center gap-2" aria-hidden="true">
                  {CAPABILITIES.map((c, i) => (
                    <span
                      key={c.id}
                      className={`h-1 rounded-full transition-all duration-500 ${i === active ? "w-8 bg-sun" : "w-1.5 bg-fg/20"}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
