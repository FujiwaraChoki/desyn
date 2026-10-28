"use client";

import { Logo, Orbs } from "@desyn/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { Rich } from "@/components/rich";

/** Centered card on the atmospheric background, for pages outside the dashboard (invites, share). */
export function PublicShell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      <Orbs intensity={0.7} />
      <header className="relative z-[1] flex items-center justify-between px-4 py-5 sm:px-8">
        <Link
          href="/"
          className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Logo size={22} />
        </Link>
        {aside}
      </header>
      <main className="relative z-[1] flex flex-1 items-center justify-center px-4 pb-16">
        {children}
      </main>
    </div>
  );
}

export function PublicCard({
  title,
  body,
  children,
}: {
  title: string;
  body?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rise panel-edge w-full max-w-md rounded-[22px] border border-line-subtle bg-glass p-7 backdrop-blur-[20px] sm:p-9">
      <h1 className="rich-title font-serif text-[36px] leading-[1.08] tracking-[-0.01em] text-fg">
        <Rich text={title} />
      </h1>
      {body ? <div className="mt-3 text-sm leading-6 text-fg-muted">{body}</div> : null}
      {children ? <div className="mt-7 flex flex-col gap-2.5">{children}</div> : null}
    </div>
  );
}
