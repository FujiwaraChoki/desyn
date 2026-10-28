import { MessageCircle } from "lucide-react";
import { Vignette } from "@/components/capabilities/Vignettes";
import { TemplateArt } from "@/components/templates/TemplateArt";
import type { FeatureVisual as Visual } from "@/lib/content/features";
import { TEMPLATE_SPECS, type TemplateSpec } from "@/lib/templates";

const spec = (slug: string) => TEMPLATE_SPECS.find((t) => t.slug === slug) as TemplateSpec;

function Cursor({ name, color, className }: { name: string; color: string; className: string }) {
  return (
    <div className={`pointer-events-none absolute ${className}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M2 2l5 14 2.2-5.8L15 8z"
          fill={color}
          stroke="#0a0a0a"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="ml-3 mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium text-[#0a0a0a]"
        style={{ background: color }}
      >
        {name}
      </span>
    </div>
  );
}

function Collab() {
  return (
    <div
      role="img"
      aria-label="Three collaborators, one of them the AI, editing a poster at the same time, with a comment pinned to it."
      className="dot-grid panel-edge relative aspect-[4/3] w-full overflow-hidden rounded-[22px] border border-fg/10"
    >
      <div className="absolute left-1/2 top-[8%] h-[84%] -translate-x-1/2 overflow-hidden rounded-[8px] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)]">
        <TemplateArt
          spec={spec("open-studio")}
          idSuffix="-collab"
          className="block h-full w-auto"
        />
        <div className="absolute inset-x-[10%] top-[63%] h-[18%] rounded-[3px] border-[1.5px] border-[#7ab8ff]" />
        <div className="absolute left-[30%] top-[20%] h-[36%] w-[40%] rounded-[3px] border-[1.5px] border-sun" />
      </div>
      <Cursor name="Ana" color="#7ab8ff" className="cf-a left-[26%] top-[72%]" />
      <Cursor name="Desyn AI" color="#ffb02e" className="cf-b left-[58%] top-[30%]" />
      <Cursor name="Leo" color="#4ade80" className="cf-c left-[70%] top-[78%]" />
      <div className="absolute right-[5%] top-[8%] w-[32%] rounded-[14px] border border-fg/10 bg-bg/85 p-3 text-[clamp(10px,1vw,12.5px)] leading-5 text-fg/80 shadow-xl backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-subtle">
          <MessageCircle size={12} strokeWidth={1.75} aria-hidden="true" /> Comment on Headline
        </div>
        <p>
          <span className="text-fg">Leo:</span> Can we try this in italic?
        </p>
        <p className="mt-1">
          <span className="text-sun-text">Desyn AI:</span> Done. Set in Instrument Serif italic.
        </p>
      </div>
    </div>
  );
}

function SelfHost() {
  const boxes = [
    { name: "Web app", tech: "Next.js", col: "col-start-2", row: "row-start-1" },
    {
      name: "Convex backend",
      tech: "data · realtime · functions",
      col: "col-start-2",
      row: "row-start-2",
    },
    { name: "Render worker", tech: "Rust", col: "col-start-3", row: "row-start-2" },
    { name: "Object storage", tech: "S3 · MinIO · R2", col: "col-start-1", row: "row-start-3" },
    { name: "Email", tech: "SMTP · SES", col: "col-start-2", row: "row-start-3" },
    {
      name: "AI providers",
      tech: "your keys · local",
      col: "col-start-3",
      row: "row-start-3",
      optional: true,
    },
  ];
  return (
    <div
      role="img"
      aria-label="Self-hosted architecture: a web app and a Convex backend, a Rust render worker, object storage, email and optional AI providers, all on your server."
      className="dot-grid panel-edge relative aspect-[4/3] w-full overflow-hidden rounded-[22px] border border-fg/10 p-[6%]"
    >
      <div className="relative h-full rounded-[16px] border border-dashed border-sun/40 p-[5%]">
        <span className="label absolute -top-2.5 left-4 bg-canvas px-2 text-[10px] text-sun-text">
          your server
        </span>
        <div className="grid h-full grid-cols-3 grid-rows-3 gap-[5%]">
          <div className="col-start-1 row-start-1 flex flex-col items-center justify-center rounded-[12px] border border-fg/10 bg-bg/40 text-center">
            <span className="text-[clamp(11px,1.2vw,14px)] text-fg/80">Browser</span>
            <span className="font-mono text-[clamp(9px,0.9vw,11px)] text-subtle">
              desktop · iOS
            </span>
          </div>
          {boxes.map((b) => (
            <div
              key={b.name}
              className={`${b.col} ${b.row} flex flex-col items-center justify-center rounded-[12px] border text-center ${
                b.optional
                  ? "border-dashed border-fg/15 bg-transparent"
                  : "border-fg/10 bg-surface-1/90"
              }`}
            >
              <span className="text-[clamp(11px,1.2vw,14px)] text-fg/90">{b.name}</span>
              <span className="font-mono text-[clamp(9px,0.9vw,11px)] text-subtle">{b.tech}</span>
            </div>
          ))}
          <div className="col-start-3 row-start-1 flex items-center justify-center">
            <span className="rounded-full bg-sun/15 px-3 py-1 text-[clamp(10px,1vw,12px)] text-sun-text">
              every feature on
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Gallery() {
  const picks = ["slow-mornings", "wedding", "late-light", "novel", "wine-bar", "run-club"].map(
    spec,
  );
  return (
    <div className="grid grid-cols-3 items-end gap-3 sm:gap-4">
      {picks.map((s, i) => (
        <div
          key={s.slug}
          className={`overflow-hidden rounded-[10px] shadow-[0_24px_48px_-24px_rgba(0,0,0,.7)] ring-1 ring-fg/10 ${i % 2 ? "translate-y-4" : ""}`}
        >
          <TemplateArt spec={s} idSuffix="-fg" className="block h-auto w-full" title={s.title} />
        </div>
      ))}
    </div>
  );
}

export function FeatureVisual({ visual }: { visual: Visual }) {
  if (visual === "collab") return <Collab />;
  if (visual === "selfhost") return <SelfHost />;
  if (visual === "gallery") return <Gallery />;
  return <Vignette id={visual} />;
}
