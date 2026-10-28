import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { SIGNUP_URL } from "@/lib/site";
import { SunMark } from "./Logo";
import { Reveal } from "./Reveal";

/** A compact closing call to action for inner pages. */
export function CtaBand({
  title = (
    <>
      Your first design is <em className="em text-sun-gradient">a sentence</em> away.
    </>
  ),
  body = "Start free in the browser. Upgrade when you want the AI.",
}: {
  title?: ReactNode;
  body?: string;
}) {
  return (
    <section className="section pt-0">
      <div className="container-wide">
        <Reveal>
          <div className="relative overflow-hidden rounded-[32px] border border-fg/10 bg-surface-1/70 px-6 py-16 text-center sm:px-12 sm:py-20">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -bottom-[60%] mx-auto aspect-square w-[70%] rounded-full bg-[radial-gradient(circle,rgb(var(--sun-rgb)/0.35),transparent_62%)]"
            />
            <div
              aria-hidden="true"
              className="absolute inset-x-[10%] bottom-0 h-px bg-gradient-to-r from-transparent via-sun/70 to-transparent"
            />
            <SunMark size={36} className="relative mx-auto" />
            <h2 className="title relative mx-auto mt-6 max-w-3xl">{title}</h2>
            <p className="subhead relative mx-auto mt-5 max-w-lg">{body}</p>
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg group relative mt-9">
              Start designing — free
              <ArrowRight
                size={18}
                strokeWidth={1.75}
                className="transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
