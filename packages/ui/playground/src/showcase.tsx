import { cn, Eyebrow, type ThemeName, ThemeScope } from "@desyn/ui";
import type { ReactNode } from "react";

export interface ShowcaseProps {
  id: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  /** Rendered once per theme so every component is reviewed in dark and light. */
  children: (theme: ThemeName) => ReactNode;
  className?: string;
}

/** A gallery section rendered side by side in both themes. */
export function Showcase({ id, eyebrow, title, description, children, className }: ShowcaseProps) {
  return (
    <section id={id} className="scroll-mt-20">
      <header className="mb-5 flex flex-col gap-2">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="font-serif text-[34px] leading-tight text-fg [&_em]:text-accent [&_em]:italic">
          {title}
        </h2>
        {description ? <p className="max-w-2xl text-sm text-fg-muted">{description}</p> : null}
      </header>
      <div className={cn("grid gap-4 lg:grid-cols-2", className)}>
        {(["dark", "light"] as const).map((theme) => (
          <ThemeScope
            key={theme}
            theme={theme}
            className="relative min-w-0 rounded-panel border border-line-subtle bg-background p-5 shadow-[0_1px_0_var(--line-subtle)] sm:p-6"
          >
            <span className="absolute top-3 right-4 text-[11px] font-medium text-fg-muted">
              {theme === "dark" ? "Dark" : "Light"}
            </span>
            {children(theme)}
          </ThemeScope>
        ))}
      </div>
    </section>
  );
}

/** A labelled row inside a showcase panel. */
export function Row({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-2xs font-medium text-fg-muted">{label}</span>
      <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>
    </div>
  );
}

export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-6", className)}>{children}</div>;
}
