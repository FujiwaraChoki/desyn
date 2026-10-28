import type { ReactNode } from "react";

/** The opening block of every inner page: eyebrow, serif title, one paragraph, orbs behind. */
export function PageHero({
  eyebrow,
  title,
  children,
  align = "center",
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  align?: "center" | "left";
  actions?: ReactNode;
}) {
  const centered = align === "center";
  return (
    <section className="relative overflow-hidden pb-16 pt-36 md:pb-24 md:pt-48">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="orb orb-float-1 -right-24 -top-32 size-[520px]" />
        <div className="orb orb-ember orb-float-2 -left-40 top-24 size-[420px] opacity-[calc(var(--orb-opacity)*0.6)]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-bg" />
      </div>
      <div className={`container-wide relative ${centered ? "text-center" : ""}`}>
        <div className={centered ? "mx-auto max-w-4xl" : "max-w-3xl"}>
          {/* CSS entrances (not JS) so the headline paints with the first frame: it is the LCP element. */}
          <p className="label page-in">{eyebrow}</p>
          <h1
            className="page-in mt-5 font-serif text-[clamp(52px,8vw,112px)] leading-[0.95] tracking-[-0.02em]"
            style={{ "--d": "60ms" } as React.CSSProperties}
          >
            {title}
          </h1>
          {children ? (
            <div
              className={`subhead page-in mt-7 ${centered ? "mx-auto max-w-2xl" : "max-w-2xl"}`}
              style={{ "--d": "140ms" } as React.CSSProperties}
            >
              {children}
            </div>
          ) : null}
          {actions ? (
            <div
              className={`page-in mt-10 flex flex-wrap gap-3 ${centered ? "justify-center" : ""}`}
              style={{ "--d": "220ms" } as React.CSSProperties}
            >
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
