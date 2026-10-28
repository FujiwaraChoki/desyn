import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Reveal } from "@/components/site/Reveal";
import { Em, SectionIntro } from "@/components/site/SectionIntro";
import { BrowserFrame, DesktopFrame, PhoneFrame } from "./Devices";

const PLATFORMS = [
  {
    name: "Desktop",
    detail:
      "A native app for macOS, Windows and Linux, written in Rust. Fast, and it keeps working offline.",
  },
  { name: "Web", detail: "Open app.desyn.app in any modern browser. Nothing to install." },
  {
    name: "iPhone & iPad",
    detail: "A native SwiftUI app with touch and Apple Pencil, synced with everything else.",
  },
];

export function Platforms() {
  return (
    <section className="section relative overflow-hidden" aria-labelledby="platforms-title">
      <div
        className="orb orb-ember orb-float-1 right-[-10%] top-[20%] size-[560px]"
        aria-hidden="true"
      />
      <div className="container-wide relative">
        <SectionIntro
          id="platforms-title"
          eyebrow="Every platform"
          title={
            <>
              Wherever you <Em>work.</Em>
            </>
          }
        >
          The same editor and the same engine on every device, so a design looks identical
          everywhere you open it.
        </SectionIntro>

        <div className="relative mx-auto mt-20 grid max-w-6xl grid-cols-12 items-end gap-4 sm:gap-6">
          <Reveal className="col-span-12 sm:col-span-5 sm:translate-y-6" delay={0.1}>
            <DesktopFrame />
          </Reveal>
          <Reveal className="col-span-9 sm:col-span-5" delay={0}>
            <BrowserFrame />
          </Reveal>
          <Reveal className="col-span-3 sm:col-span-2" delay={0.2}>
            <PhoneFrame />
          </Reveal>
        </div>

        <div className="mx-auto mt-16 grid max-w-5xl gap-10 sm:grid-cols-3">
          {PLATFORMS.map((p, i) => (
            <Reveal key={p.name} delay={i * 0.08}>
              <h3 className="font-serif text-[28px] leading-tight">{p.name}</h3>
              <p className="body mt-2 text-[15px]">{p.detail}</p>
            </Reveal>
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <Link
            href="/download"
            className="link inline-flex items-center gap-2 text-[15px] no-underline"
          >
            Desktop and iOS availability{" "}
            <ArrowRight size={15} strokeWidth={1.5} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
