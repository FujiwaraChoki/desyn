import { Check, Languages } from "lucide-react";
import { Art } from "@/components/demo/Art";
import { SunMark } from "@/components/site/Logo";
import { TemplateArt } from "@/components/templates/TemplateArt";
import type { VignetteId } from "@/lib/content/capabilities";
import { TEMPLATE_SPECS, type TemplateSpec } from "@/lib/templates";

/*
 * Six small animated scenes, one per capability. Pure CSS loops (see .vg-* in globals.css) so
 * they cost nothing when off screen and freeze cleanly under prefers-reduced-motion.
 */

const spec = (slug: string) => TEMPLATE_SPECS.find((t) => t.slug === slug) as TemplateSpec;

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="dot-grid panel-edge relative aspect-[4/3] w-full overflow-hidden rounded-[22px] border border-fg/10"
    >
      {children}
    </div>
  );
}

function Generate() {
  const cards = [spec("wine-bar"), spec("slow-mornings"), spec("late-light")];
  return (
    <Frame label="A one-line prompt becomes three complete designs.">
      <div className="absolute inset-x-[8%] top-[9%] flex items-center gap-2 rounded-full border border-fg/10 bg-bg/70 px-4 py-2.5 text-[clamp(11px,1.1vw,13px)] text-fg/80 backdrop-blur">
        <span className="vg-type truncate">A menu, a poster and a post for our wine bar</span>
        <span className="caret" />
      </div>
      <div className="absolute inset-x-[8%] bottom-[9%] top-[30%] grid grid-cols-3 items-end gap-[3%]">
        {cards.map((c, i) => (
          <div
            key={c.slug}
            className="vg-rise overflow-hidden rounded-[8px] shadow-[0_20px_40px_-20px_rgba(0,0,0,.6)]"
            style={{ "--vd": `${0.6 + i * 0.35}s` } as React.CSSProperties}
          >
            <TemplateArt spec={c} idSuffix="-vg" className="block h-auto w-full" />
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Talk() {
  return (
    <Frame label="Asking for a warmer title changes only the headline layer.">
      <div className="absolute left-[8%] top-[10%] h-[80%] w-[46%] overflow-hidden rounded-[8px] bg-[linear-gradient(180deg,#1c0f0a,#3d1a0e)] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)]">
        <div className="absolute left-[34%] top-[8%] aspect-square w-[58%] rounded-full border border-[#ffb02e]/60" />
        <div className="absolute left-[44%] top-[18%] aspect-square w-[38%] rounded-full bg-[#ffb02e]/25" />
        <p className="label absolute left-[9%] top-[60%] text-[clamp(6px,0.6vw,8px)] text-[#ffb02e]">
          Fri · 9 pm
        </p>
        <div className="absolute left-[7%] top-[66%] w-[86%]">
          <span className="vg-ring absolute -inset-1.5 rounded-[4px]" />
          <p className="vg-warm relative font-serif text-[clamp(18px,2.2vw,30px)] leading-none">
            Late light jazz.
          </p>
        </div>
        <div className="absolute bottom-[8%] left-[9%] h-[7%] w-[34%] rounded-full bg-[#ffb02e]" />
      </div>
      <div className="absolute right-[7%] top-[18%] flex w-[38%] flex-col gap-2.5">
        <p
          className="vg-pop self-end rounded-[14px] rounded-br-[4px] bg-fg/10 px-3 py-2 text-[clamp(10px,1vw,13px)] text-fg/90"
          style={{ "--vd": "0.4s" } as React.CSSProperties}
        >
          Make the title warmer
        </p>
        <div
          className="vg-pop flex items-start gap-2 rounded-[14px] rounded-bl-[4px] border border-fg/10 bg-bg/60 px-3 py-2 text-[clamp(10px,1vw,13px)] text-fg/75"
          style={{ "--vd": "1.5s" } as React.CSSProperties}
        >
          <Check size={14} className="mt-0.5 shrink-0 text-sun" aria-hidden="true" />
          <span>
            Changed <span className="text-fg">Headline</span> to amber. 1 of 6 layers.
          </span>
        </div>
      </div>
    </Frame>
  );
}

function Understand() {
  const boxes = [
    { l: "28%", t: "8%", w: "44%", h: "6%", tag: "eyebrow · 9.5 pt" },
    { l: "26%", t: "22%", w: "48%", h: "38%", tag: "photo · product" },
    { l: "16%", t: "64%", w: "68%", h: "10%", tag: "headline · rank 1" },
    { l: "36%", t: "84%", w: "28%", h: "7%", tag: "cta · button" },
  ];
  return (
    <Frame label="Desyn labels every element by role and flags a contrast problem.">
      <div className="absolute left-1/2 top-[7%] h-[86%] -translate-x-1/2">
        <div className="relative h-full overflow-hidden rounded-[8px] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)]">
          <TemplateArt
            spec={spec("slow-mornings")}
            idSuffix="-vu"
            className="block h-full w-auto"
          />
          {boxes.map((b, i) => (
            <div
              key={b.tag}
              className="vg-box absolute border border-dashed border-sun"
              style={
                {
                  left: b.l,
                  top: b.t,
                  width: b.w,
                  height: b.h,
                  "--vd": `${0.3 + i * 0.45}s`,
                } as React.CSSProperties
              }
            >
              <span className="absolute -top-[18px] left-0 whitespace-nowrap rounded-[3px] bg-sun px-1 font-mono text-[9px] leading-[14px] text-on-sun">
                {b.tag}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div
        className="vg-pop absolute bottom-[7%] right-[5%] flex items-center gap-2 rounded-full border border-fg/10 bg-bg/80 px-3 py-1.5 text-[clamp(10px,1vw,12px)] text-fg/80 backdrop-blur"
        style={{ "--vd": "2.4s" } as React.CSSProperties}
      >
        <span className="size-1.5 rounded-full bg-success" />
        Low contrast on subhead, fixed
      </div>
      <div
        className="vg-pop absolute left-[5%] top-[7%] rounded-[10px] border border-fg/10 bg-bg/80 px-3 py-2 font-mono text-[10px] leading-4 text-fg/60 backdrop-blur"
        style={{ "--vd": "0.1s" } as React.CSSProperties}
      >
        hierarchy ✓<br />
        margins 48 px
        <br />
        rhythm 8 px
      </div>
    </Frame>
  );
}

function Assets() {
  return (
    <Frame label="A product photo has its background removed by a sweeping scan.">
      <div className="absolute left-1/2 top-[8%] aspect-square h-[68%] -translate-x-1/2 overflow-hidden rounded-[10px] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)]">
        <div className="absolute inset-0 bg-[repeating-conic-gradient(#d9d4cc_0_25%,#f4f1ec_0_50%)] bg-[length:16px_16px]" />
        <div className="vg-wipe absolute inset-0 bg-[linear-gradient(160deg,#f3c58a,#e07a3c)]" />
        <div
          className="absolute inset-[12%]"
          style={
            {
              "--art-a": "#efe4d6",
              "--art-b": "#b7896b",
              "--art-c": "#5b3a26",
            } as React.CSSProperties
          }
        >
          <Art art="cup" uid="vg-assets" />
        </div>
        <div className="vg-scan absolute inset-y-0 w-[2px] bg-sun" />
      </div>
      <div className="absolute inset-x-[6%] bottom-[7%] flex flex-wrap justify-center gap-1.5">
        {["Generate image", "Remove background", "Upscale 4×", "Outpaint"].map((t, i) => (
          <span
            key={t}
            className={`rounded-full border px-3 py-1 text-[clamp(10px,1vw,12px)] ${i === 1 ? "border-sun/60 bg-sun/15 text-fg" : "border-fg/10 bg-bg/60 text-fg/65"}`}
          >
            {t}
          </span>
        ))}
      </div>
    </Frame>
  );
}

function Brand() {
  const swatches = ["#1d3b2a", "#e8dcc4", "#c96f3b", "#f4efe6"];
  return (
    <Frame label="A brand kit's colours and fonts restyle three designs.">
      <div className="absolute left-[6%] top-[10%] flex w-[36%] flex-col gap-3 rounded-[14px] border border-fg/10 bg-bg/70 p-[4%] backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full bg-[#1d3b2a]">
            <SunMark size={14} />
          </span>
          <span className="font-serif text-[clamp(14px,1.5vw,20px)] leading-none">
            Fern & Field
          </span>
        </div>
        <div className="flex gap-1.5">
          {swatches.map((c) => (
            <span
              key={c}
              className="h-[clamp(16px,2vw,24px)] flex-1 rounded-[5px] border border-fg/10"
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="space-y-1 text-[clamp(9px,0.9vw,11px)] text-fg/60">
          <p>
            <span className="text-fg/85">Fraunces</span> headlines
          </p>
          <p>
            <span className="text-fg/85">Inter</span> body
          </p>
          <p>Voice: warm, plain, unhurried</p>
        </div>
      </div>
      <div className="absolute right-[6%] top-[10%] grid h-[80%] w-[48%] grid-cols-2 grid-rows-2 gap-[5%]">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`vg-brand relative overflow-hidden rounded-[8px] ${i === 0 ? "row-span-2" : ""}`}
            style={{ "--vd": `${0.4 + i * 0.3}s` } as React.CSSProperties}
          >
            <span className="vg-brand-title absolute left-[10%] top-[12%] font-serif text-[clamp(12px,1.4vw,20px)] leading-none">
              {["Harvest box", "Open day", "New seeds"][i]}
            </span>
            <span className="vg-brand-dot absolute bottom-[12%] right-[12%] aspect-square w-[34%] rounded-full" />
            <span className="vg-brand-bar absolute bottom-[12%] left-[10%] h-[8%] w-[36%] rounded-full" />
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Workflows() {
  const outputs = [
    { s: "story", ratio: "9/16", w: "13%", l: "56%", t: "14%", lang: "EN" },
    { s: "square", ratio: "1/1", w: "20%", l: "73%", t: "12%", lang: "FR" },
    { s: "banner", ratio: "3/1", w: "30%", l: "60%", t: "60%", lang: "DE" },
    { s: "slide", ratio: "16/9", w: "22%", l: "72%", t: "35%", lang: "JA" },
  ];
  const src = spec("summer-sale");
  return (
    <Frame label="One design is resized and translated into four variants.">
      <div className="absolute left-[7%] top-1/2 w-[30%] -translate-y-1/2 overflow-hidden rounded-[8px] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)]">
        <TemplateArt spec={src} idSuffix="-vw" className="block h-auto w-full" />
      </div>
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 400 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[54, 50, 196, 120].map((y, i) => (
          <path
            key={y}
            className="vg-draw"
            style={{ "--vd": `${0.2 + i * 0.25}s` } as React.CSSProperties}
            d={`M150 150 C 190 150, 200 ${y}, ${[226, 292, 240, 288][i]} ${y + 10}`}
            fill="none"
            stroke="var(--sun)"
            strokeOpacity="0.55"
            strokeWidth="1"
            pathLength={1}
          />
        ))}
      </svg>
      {outputs.map((o, i) => (
        <div
          key={o.s}
          className="vg-rise absolute overflow-hidden rounded-[6px] border border-fg/10 bg-[linear-gradient(160deg,#fff8e6,#ffe3a0)] shadow-[0_16px_30px_-16px_rgba(0,0,0,.7)]"
          style={
            {
              left: o.l,
              top: o.t,
              width: o.w,
              aspectRatio: o.ratio,
              "--vd": `${0.6 + i * 0.25}s`,
            } as React.CSSProperties
          }
        >
          <span className="absolute left-[8%] top-[8%] h-[10%] w-[50%] rounded-sm bg-[#ff6a1f]" />
          <span className="absolute bottom-[10%] right-[8%] aspect-square w-[30%] rounded-full bg-[#1f1a10]/80" />
          <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-[3px] bg-[#1f1a10] px-1 font-mono text-[8px] leading-3 text-[#fff8e6]">
            {o.lang}
          </span>
        </div>
      ))}
      <div className="absolute bottom-[7%] left-[7%] flex items-center gap-2 text-[clamp(10px,1vw,12px)] text-fg/60">
        <Languages size={14} strokeWidth={1.5} className="text-sun" aria-hidden="true" /> 4 sizes ·
        4 languages · one click
      </div>
    </Frame>
  );
}

const MAP: Record<VignetteId, () => React.ReactElement> = {
  generate: Generate,
  talk: Talk,
  understand: Understand,
  assets: Assets,
  brand: Brand,
  workflows: Workflows,
};

export function Vignette({ id }: { id: VignetteId }) {
  const C = MAP[id];
  return <C />;
}
