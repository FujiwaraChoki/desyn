"use client";

import { Logo, Orbs } from "@desyn/ui";
import type { ReactNode } from "react";
import { Rich } from "@/components/rich";
import { publicEnv } from "@/lib/env";
import { useT } from "@/lib/i18n";
import { SunArt } from "./sun-art";

/**
 * Layout for every auth screen: the form column on the left and the rising sun on the right
 * (desktop), the form alone over soft orbs on phones.
 */
export function AuthShell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  const t = useT();
  return (
    <div className="relative grid min-h-dvh grid-cols-1 overflow-hidden bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Orbs intensity={0.7} className="lg:hidden" />
      <div className="relative z-[1] flex min-h-dvh flex-col px-4 py-6 sm:px-10 lg:px-16">
        <header className="flex items-center justify-between">
          <a
            href={publicEnv.siteUrl}
            className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Logo size={22} />
          </a>
          {aside}
        </header>
        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </main>
        <footer className="text-center text-xs text-fg-muted lg:text-left">
          © {new Date().getFullYear()} Desyn ·{" "}
          <a className="hover:text-fg" href={`${publicEnv.siteUrl}/legal/privacy`}>
            {t("auth.privacy")}
          </a>{" "}
          ·{" "}
          <a className="hover:text-fg" href={`${publicEnv.siteUrl}/legal/terms`}>
            {t("auth.terms")}
          </a>
        </footer>
      </div>
      <div className="relative hidden p-4 lg:block">
        <SunArt caption={<Rich text={t("auth.tagline")} />} body={t("auth.taglineBody")} />
      </div>
    </div>
  );
}

/** Serif page title with one italic sun word, plus a muted subtitle. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="rich-title rise font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[48px]">
        <Rich text={title} />
      </h1>
      {subtitle ? (
        <p className="rise mt-3 text-sm leading-6 text-fg-muted" style={{ ["--i" as string]: 1 }}>
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export function OrDivider() {
  const t = useT();
  return (
    <div className="my-6 flex items-center gap-3 text-2xs text-fg-muted">
      <span className="h-px flex-1 bg-line-subtle" />
      {t("auth.or")}
      <span className="h-px flex-1 bg-line-subtle" />
    </div>
  );
}
