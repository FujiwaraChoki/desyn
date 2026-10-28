import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_DOCS, type LegalSlug } from "@/lib/content/legal";

export function LegalLayout({
  slug,
  title,
  updated,
  intro,
  children,
}: {
  slug: LegalSlug;
  title: string;
  updated: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="container-wide pb-24 pt-36 md:pt-44">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-20">
        <nav aria-label="Legal documents" className="min-w-0 lg:sticky lg:top-28 lg:self-start">
          <p className="label mb-4 text-[11px]">Legal</p>
          <ul className="no-scrollbar flex gap-2 overflow-x-auto lg:flex-col lg:gap-1">
            {LEGAL_DOCS.map((d) => (
              <li key={d.slug}>
                <Link
                  href={`/legal/${d.slug}`}
                  aria-current={d.slug === slug ? "page" : undefined}
                  className={`block whitespace-nowrap rounded-full px-4 py-2 text-[14px] transition-colors lg:rounded-[8px] lg:px-3 ${
                    d.slug === slug ? "bg-sun/12 text-fg" : "text-fg/60 hover:bg-fg/5 hover:text-fg"
                  }`}
                >
                  {d.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="max-w-[720px]">
          <h1 className="font-serif text-[clamp(44px,6vw,76px)] leading-[1] tracking-[-0.015em]">
            {title}
          </h1>
          <p className="mt-4 text-[14px] text-subtle">Last updated {updated}</p>
          <div className="mt-8 rounded-[14px] border border-sun/25 bg-sun/[0.06] px-5 py-4 text-[14px] leading-6 text-fg/75">
            Draft pending legal review. This text explains our intentions in plain language and may
            change before launch. If anything here is unclear, write to us.
          </div>
          {intro ? <div className="subhead mt-10">{intro}</div> : null}
          <div className="prose-desyn mt-6">{children}</div>
        </article>
      </div>
    </div>
  );
}
