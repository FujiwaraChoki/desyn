import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

export function SectionIntro({
  eyebrow,
  title,
  children,
  align = "center",
  as: Heading = "h2",
  className = "",
  id,
}: {
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  align?: "center" | "left";
  as?: "h1" | "h2";
  className?: string;
  id?: string;
}) {
  const centered = align === "center";
  return (
    <div className={`${centered ? "mx-auto max-w-3xl text-center" : "max-w-2xl"} ${className}`}>
      {eyebrow ? (
        <Reveal>
          <p className="label">{eyebrow}</p>
        </Reveal>
      ) : null}
      <Reveal delay={0.08}>
        <Heading id={id} className={`title ${eyebrow ? "mt-5" : ""}`}>
          {title}
        </Heading>
      </Reveal>
      {children ? (
        <Reveal delay={0.16}>
          <div className={`subhead mt-6 ${centered ? "mx-auto max-w-xl" : "max-w-xl"}`}>
            {children}
          </div>
        </Reveal>
      ) : null}
    </div>
  );
}

/** Italic emphasis word in the sun colour: the one accent per headline. */
export function Em({ children }: { children: ReactNode }) {
  return <em className="em text-sun-gradient">{children}</em>;
}
