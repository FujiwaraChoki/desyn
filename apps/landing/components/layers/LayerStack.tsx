"use client";

import {
  type MotionValue,
  motion,
  useMotionTemplate,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useRef } from "react";
import { Art } from "@/components/demo/Art";
import { Em } from "@/components/site/SectionIntro";
import { usePrefersReducedMotion } from "@/components/site/usePrefersReducedMotion";

const SLABS = [
  { id: "bg", name: "Background", type: "rect" },
  { id: "sun", name: "Sun disc", type: "ellipse" },
  { id: "photo", name: "Product photo", type: "image" },
  { id: "headline", name: "Headline", type: "text" },
  { id: "cta", name: "Button", type: "button" },
] as const;

const STEPS = [
  {
    at: [0, 0.22],
    title: "It looks like a picture.",
    body: "A finished poster. Most AI tools stop here: a flat image you can only regenerate.",
  },
  {
    at: [0.22, 0.58],
    title: "It is made of layers.",
    body: "Every element is a real layer with a name, a role and properties. The AI reads them the way a designer does.",
  },
  {
    at: [0.58, 1],
    title: "So edits stay precise.",
    body: "“Make the headline warmer” changes the headline. The cup, the sun and the button do not move.",
  },
] as const;

function Step({ progress, index }: { progress: MotionValue<number>; index: number }) {
  const step = STEPS[index] as (typeof STEPS)[number];
  const [a, b] = step.at;
  // Fade out fully before the next step fades in, so two steps never overlap.
  const opacity = useTransform(
    progress,
    [a, a + 0.05, b - 0.06, b - 0.01],
    [index === 0 ? 1 : 0, 1, 1, index === 2 ? 1 : 0],
  );
  const y = useTransform(progress, [a, a + 0.06], [index === 0 ? 0 : 20, 0]);
  return (
    <motion.div style={{ opacity, y }} className="absolute inset-x-0 top-0">
      <p className="label">{String(index + 1).padStart(2, "0")} / 03</p>
      <h3 className="mt-4 font-serif text-[clamp(30px,3.4vw,46px)] leading-[1.05]">{step.title}</h3>
      <p className="body mt-4 max-w-sm">{step.body}</p>
    </motion.div>
  );
}

function Slab({
  index,
  progress,
  spread,
  reduced,
}: {
  index: number;
  progress: MotionValue<number>;
  spread: MotionValue<number>;
  reduced: boolean;
}) {
  const slab = SLABS[index] as (typeof SLABS)[number];
  const z = useTransform(spread, (s) => index * s);
  const isHeadline = slab.id === "headline";
  // The headline lifts out of the stack and turns warm, then settles back.
  const lift = useTransform(progress, [0.6, 0.7, 0.86, 0.94], [0, 70, 70, 0]);
  const zTotal = useTransform(
    [z, lift],
    ([zz, l]) => (zz as number) + (isHeadline ? (l as number) : 0),
  );
  // Depth is in stack units (--stack-unit, set per breakpoint on the stage) so the exploded stack
  // keeps its proportions on a 240 px phone stage instead of climbing into the copy above it.
  const transform = useMotionTemplate`translateZ(calc(${zTotal} * var(--stack-unit)))`;
  const frame = useTransform(progress, [0.18, 0.32, 0.84, 0.95], [0, 1, 1, 0]);
  const headlineColor = useTransform(progress, [0.64, 0.74], ["#2a1a0e", "#c4451c"]);
  const labelOpacity = useTransform(progress, [0.3, 0.4, 0.8, 0.88], [0, 1, 1, 0]);

  return (
    <motion.div
      className="absolute inset-0 rounded-[10px] [transform-style:preserve-3d]"
      style={
        reduced
          ? { transform: `translateZ(calc(${index * 56} * var(--stack-unit)))` }
          : { transform }
      }
    >
      <motion.div
        className="pointer-events-none absolute inset-0 rounded-[10px] border border-white/30 bg-white/[0.04] light:border-[#2a1a0e]/20 light:bg-[#2a1a0e]/[0.03]"
        style={{ opacity: reduced ? 1 : frame }}
      />
      {slab.id === "bg" && (
        <div className="absolute inset-0 rounded-[10px] bg-[linear-gradient(180deg,#f6ebdd,#ecd2b2)]" />
      )}
      {slab.id === "sun" && (
        <div className="absolute left-[25%] top-[18.5%] aspect-square w-1/2 rounded-full bg-[#f4a63a]/90" />
      )}
      {slab.id === "photo" && (
        <div
          className="absolute left-[27.8%] top-[23.7%] aspect-square w-[44.4%]"
          style={
            {
              "--art-a": "#e9dccb",
              "--art-b": "#b9886a",
              "--art-c": "#5b3a26",
            } as React.CSSProperties
          }
        >
          <Art art="cup" uid={`stack-${index}`} />
        </div>
      )}
      {isHeadline && (
        <motion.p
          className="absolute inset-x-0 top-[63%] text-center font-serif text-[clamp(30px,4.2vw,46px)] leading-none"
          style={{ color: reduced ? "#2a1a0e" : headlineColor }}
        >
          Slow mornings.
        </motion.p>
      )}
      {slab.id === "cta" && (
        <div className="absolute left-1/2 top-[84%] flex h-[7%] w-[30%] -translate-x-1/2 items-center justify-center rounded-full bg-[#2a1a0e] font-semibold text-[#f6ebdd] [container-type:inline-size]">
          {/* Sized to the pill (cqw) so the label never wraps out of it on a phone-sized stage. */}
          <span className="whitespace-nowrap text-[11cqw] leading-none">Pre-order now</span>
        </div>
      )}
      {/* Billboarded label: counter-rotates the stack's tilt so it faces the viewer. */}
      <motion.div
        className="absolute -right-3 top-1/2 origin-left [transform-style:preserve-3d]"
        style={{ opacity: reduced ? 1 : labelOpacity }}
      >
        <div className="flex items-center gap-2 whitespace-nowrap [transform:rotateZ(36deg)_rotateX(-56deg)_translateX(14px)]">
          <span className="h-px w-10 bg-fg/40" />
          <span className="rounded-full border border-fg/15 bg-bg/85 px-2.5 py-1 text-[11px] text-fg/90 backdrop-blur sm:px-3 sm:py-1.5 sm:text-[13px]">
            {slab.name} <span className="font-mono text-subtle">· {slab.type}</span>
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function LayerStack() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });

  const rotateX = useTransform(progress, [0.12, 0.38, 0.86, 0.98], [0, 56, 56, 0]);
  const rotateZ = useTransform(progress, [0.12, 0.38, 0.86, 0.98], [0, -36, -36, 0]);
  const spread = useTransform(progress, [0.16, 0.42, 0.84, 0.97], [0, 64, 64, 0]);
  const scale = useTransform(progress, [0.12, 0.38, 0.86, 0.98], [1, 0.82, 0.82, 1]);
  const stackTransform = useMotionTemplate`rotateX(${rotateX}deg) rotateZ(${rotateZ}deg) scale(${scale})`;

  if (reduced) {
    return (
      <div className="container-wide grid items-center gap-16 py-10 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-10">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <p className="label">{String(i + 1).padStart(2, "0")} / 03</p>
              <h3 className="mt-3 font-serif text-[34px] leading-tight">{s.title}</h3>
              <p className="body mt-3 max-w-sm">{s.body}</p>
            </div>
          ))}
        </div>
        <StackStage transform="rotateX(56deg) rotateZ(-36deg) scale(0.82)">
          {SLABS.map((s, i) => (
            <Slab key={s.id} index={i} progress={progress} spread={spread} reduced />
          ))}
        </StackStage>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative h-[290vh]">
      <div className="sticky top-0 flex h-[100svh] items-center overflow-hidden">
        <div className="container-wide grid w-full items-center gap-6 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <div>
            <h2 className="title">
              Not a picture. <Em>Layers.</Em>
            </h2>
            <div className="relative mt-6 h-[210px] sm:h-[180px] lg:mt-12 lg:h-[200px]">
              {STEPS.map((s, i) => (
                <Step key={s.title} progress={progress} index={i} />
              ))}
            </div>
          </div>
          <StackStage transform={stackTransform}>
            {SLABS.map((s, i) => (
              <Slab key={s.id} index={i} progress={progress} spread={spread} reduced={false} />
            ))}
          </StackStage>
        </div>
      </div>
    </div>
  );
}

function StackStage({
  transform,
  children,
}: {
  transform: MotionValue<string> | string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative mx-auto mt-14 aspect-[4/5] w-[min(50vw,240px)] [--stack-unit:0.6px] [perspective:1800px] sm:mt-16 sm:w-[320px] sm:[--stack-unit:0.8px] lg:mt-0 lg:w-[min(30vw,400px)] lg:[--stack-unit:1px]">
      <div className="orb orb-float-3 -left-1/3 top-1/4 size-[120%]" aria-hidden="true" />
      <motion.div
        className="absolute inset-0 [transform-style:preserve-3d]"
        style={{ transform }}
        role="img"
        aria-label="A poster separated into its five layers: background, sun disc, product photo, headline and button."
      >
        {children}
      </motion.div>
    </div>
  );
}
