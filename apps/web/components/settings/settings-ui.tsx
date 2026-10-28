"use client";

import { cn } from "@desyn/ui";
import {
  Bot,
  Building2,
  CreditCard,
  Gauge,
  Keyboard,
  KeyRound,
  Paintbrush,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { useApp } from "@/components/app/app-context";
import { Page } from "@/components/app/app-shell";
import { Rich } from "@/components/rich";
import { useT } from "@/lib/i18n";

export function SettingsNav() {
  const t = useT();
  const pathname = usePathname();
  const { billing } = useApp();
  const strip = useRef<HTMLDivElement | null>(null);
  // On phones the nav is a horizontal strip: bring the current section into view so the user sees
  // where they are (scrollLeft only; scrollIntoView would also move the page vertically).
  useEffect(() => {
    const el = strip.current;
    const current = el?.querySelector<HTMLElement>(`a[href="${CSS.escape(pathname)}"]`);
    if (!el || !current || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2;
  }, [pathname]);
  const groups = [
    {
      label: t("settings.nav.account"),
      items: [
        { href: "/settings/profile", label: t("settings.nav.profile"), icon: <UserRound /> },
        { href: "/settings/appearance", label: t("settings.nav.appearance"), icon: <Paintbrush /> },
        { href: "/settings/shortcuts", label: t("settings.nav.shortcuts"), icon: <Keyboard /> },
      ],
    },
    {
      label: t("settings.nav.workspace"),
      items: [
        {
          href: "/settings/workspace",
          label: t("settings.nav.workspaceGeneral"),
          icon: <Building2 />,
        },
        { href: "/settings/members", label: t("settings.nav.members"), icon: <Users /> },
      ],
    },
    {
      label: t("settings.nav.product"),
      items: [
        ...(billing
          ? [{ href: "/settings/billing", label: t("settings.nav.billing"), icon: <CreditCard /> }]
          : []),
        { href: "/settings/usage", label: t("settings.nav.usage"), icon: <Gauge /> },
        { href: "/settings/ai", label: t("settings.nav.ai"), icon: <Bot /> },
        { href: "/settings/api-keys", label: t("settings.nav.apiKeys"), icon: <KeyRound /> },
      ],
    },
  ];
  return (
    <nav aria-label={t("settings.nav.label")} className="min-w-0 lg:sticky lg:top-20 lg:self-start">
      <div
        ref={strip}
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 scrollbar-none [mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-24px),transparent)] lg:mx-0 lg:flex-col lg:gap-5 lg:overflow-visible lg:px-0 lg:[mask-image:none]"
      >
        {groups.map((g) => (
          <div key={g.label} className="flex gap-1 lg:flex-col lg:gap-0.5">
            <p className="hidden px-2.5 pb-1.5 text-2xs font-medium text-fg-muted lg:block">
              {g.label}
            </p>
            {g.items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 shrink-0 items-center gap-2.5 rounded-[8px] px-2.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4",
                    active
                      ? "bg-fg/[0.07] text-fg [&_svg]:text-accent"
                      : "text-fg-secondary hover:bg-fg/[0.045] hover:text-fg [&_svg]:text-fg-muted",
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

export function SettingsLayout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <Page>
      <h1 className="rich-title rise mb-8 font-serif text-[40px] leading-none text-fg sm:text-[48px]">
        <Rich text={t("settings.title")} />
      </h1>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-12">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}

/** A titled settings page (the right column). */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rise flex flex-col gap-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif text-[30px] leading-tight text-fg">{title}</h2>
          {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** A group of related settings, optionally titled; `tone="danger"` for destructive areas. No box: spacing separates groups. */
export function SettingsCard({
  title,
  description,
  children,
  footer,
  tone,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "danger";
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {title || description ? (
        <div>
          {title ? (
            <h3
              className={cn("text-base font-medium", tone === "danger" ? "text-danger" : "text-fg")}
            >
              {title}
            </h3>
          ) : null}
          {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
        </div>
      ) : null}
      {children ? <div className="flex flex-col gap-5">{children}</div> : null}
      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div>
      ) : null}
    </section>
  );
}

/** Label + description on the left, control on the right (stacked on phones). */
export function SettingsRow({
  label,
  description,
  children,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
            {label}
          </label>
        ) : (
          <p className="text-sm font-medium text-fg">{label}</p>
        )}
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-fg-muted">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
