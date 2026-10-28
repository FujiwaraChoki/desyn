"use client";

import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Logo,
  Progress,
  ScrollArea,
  useTheme,
} from "@desyn/ui";
import { useQuery } from "convex/react";
import {
  BookOpen,
  Coins,
  Cookie,
  FolderClosed,
  House,
  Keyboard,
  LayoutTemplate,
  LogOut,
  Palette,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { CONSENT_RESET_EVENT } from "@/components/analytics/analytics";
import { api } from "@/lib/convex-api";
import { publicEnv } from "@/lib/env";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { signOut } from "@/lib/sign-out";
import { useApp } from "./app-context";
import { SidebarFolders } from "./sidebar-folders";
import { WorkspaceSwitcher } from "./workspace-switcher";

function NavItem({
  href,
  icon,
  label,
  active,
  onNavigate,
  trailing,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  onNavigate?: (() => void) | undefined;
  trailing?: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-sm transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-[17px] [&_svg]:shrink-0",
        active
          ? "bg-fg/[0.07] text-fg [&_svg]:text-accent"
          : "text-fg-secondary hover:bg-fg/[0.045] hover:text-fg [&_svg]:text-fg-muted hover:[&_svg]:text-fg-secondary",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-full bg-accent"
        />
      ) : null}
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function CreditsMeter() {
  const t = useT();
  const { me } = useApp();
  const balance = useQuery(api.billing.credits.balance, me.features["ai.agent"] ? {} : "skip");
  if (!me.features["ai.agent"] || !balance) return null;
  const unlimited = balance.granted === null;
  return (
    <Link
      href={routes.settings("usage")}
      className="block rounded-[8px] px-2.5 py-2 transition-colors hover:bg-fg/6"
    >
      <div className="flex items-center justify-between text-2xs">
        <span className="flex items-center gap-1.5 font-medium text-fg-secondary">
          <Coins className="size-3.5 text-accent" />
          {t("app.credits.label")}
        </span>
        <span className="text-fg-muted tabular-nums">
          {unlimited
            ? t("app.credits.unlimited")
            : t("app.credits.remaining", {
                remaining: formatNumber(balance.remaining ?? 0),
                granted: formatNumber(balance.granted ?? 0),
              })}
        </span>
      </div>
      {!unlimited ? (
        <Progress
          className="mt-2"
          size="sm"
          value={balance.remaining ?? 0}
          max={Math.max(1, balance.granted ?? 1)}
          label={t("app.credits.label")}
        />
      ) : null}
      {balance.throttled ? (
        <p className="mt-1.5 text-2xs text-accent-text">{t("app.credits.throttled")}</p>
      ) : null}
    </Link>
  );
}

function UpgradeCard() {
  const t = useT();
  const { me, billing, config } = useApp();
  if (!billing || me.plan !== "free") return null;
  const price = config?.plans?.pro.priceMonthly ?? 8;
  return (
    <Button asChild variant="secondary" size="sm" className="w-full">
      <Link href={`${routes.settings("billing")}?upgrade=1`}>
        {t("app.upgrade.cta", { price: `$${price}` })}
      </Link>
    </Button>
  );
}

function UserMenu() {
  const t = useT();
  const router = useRouter();
  const { me } = useApp();
  const { theme, setTheme } = useTheme();
  const onSignOut = () => void signOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("app.user.menu")}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] p-1.5 text-left transition-colors hover:bg-fg/6 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-fg/6"
        >
          <Avatar name={me.name || me.email} src={me.image} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg">{me.name || me.email}</span>
            <span className="block truncate text-2xs text-fg-muted">{me.email}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuItem
          icon={<Settings />}
          onSelect={() => router.push(routes.settings("profile"))}
        >
          {t("common.settings")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Keyboard />}
          onSelect={() => router.push(routes.settings("shortcuts"))}
        >
          {t("app.user.shortcuts")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<BookOpen />}
          onSelect={() => window.open(publicEnv.docsUrl, "_blank", "noopener")}
        >
          {t("app.user.docs")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("app.user.theme")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
          <DropdownMenuRadioItem value="system">{t("app.user.themeSystem")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t("app.user.themeDark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t("app.user.themeLight")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {publicEnv.posthogKey || publicEnv.datafastWebsiteId ? (
          <DropdownMenuItem
            icon={<Cookie />}
            onSelect={() => window.dispatchEvent(new CustomEvent(CONSENT_RESET_EVENT))}
          >
            {t("app.user.cookies")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={<LogOut />} onSelect={onSignOut}>
          {t("app.user.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dashboard sidebar: workspace, navigation, folders, credits, upgrade and account. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const { me } = useApp();
  const items = [
    { href: routes.home, icon: <House />, label: t("app.nav.home") },
    { href: routes.templates, icon: <LayoutTemplate />, label: t("app.nav.templates") },
    { href: routes.brand, icon: <Palette />, label: t("app.nav.brand") },
    { href: routes.shared, icon: <Users />, label: t("app.nav.shared") },
  ];
  return (
    <div className="flex h-full flex-col gap-3 bg-surface-1 px-3 pt-3 pb-3">
      <div className="flex items-center justify-between px-1.5 pt-1 pb-2">
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Logo size={20} />
        </Link>
      </div>
      <WorkspaceSwitcher />
      <ScrollArea className="-mx-1 min-h-0 flex-1 px-1">
        <nav aria-label={t("app.nav.label")} className="flex flex-col gap-0.5 py-1 pl-0">
          {items.slice(0, 1).map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={isActive(pathname, item.href)}
              onNavigate={onNavigate}
            />
          ))}
          <NavItem
            href={routes.projects}
            icon={<FolderClosed />}
            label={t("app.nav.projects")}
            active={pathname === routes.projects}
            onNavigate={onNavigate}
          />
          <SidebarFolders onNavigate={onNavigate} />
          {items.slice(1).map((item) => (
            <NavItem
              key={item.href}
              {...item}
              active={isActive(pathname, item.href)}
              onNavigate={onNavigate}
            />
          ))}
          <NavItem
            href={routes.trash}
            icon={<Trash2 />}
            label={t("app.nav.trash")}
            active={isActive(pathname, routes.trash)}
            onNavigate={onNavigate}
          />
          <div className="my-2 h-px bg-line-subtle" />
          <NavItem
            href={routes.settings("profile")}
            icon={<Settings />}
            label={t("app.nav.settings")}
            active={isActive(pathname, "/settings")}
            onNavigate={onNavigate}
          />
          {me.isAdmin ? (
            <NavItem
              href={routes.admin}
              icon={<ShieldCheck />}
              label={t("app.nav.admin")}
              active={isActive(pathname, routes.admin)}
              onNavigate={onNavigate}
            />
          ) : null}
        </nav>
      </ScrollArea>
      <div className="flex flex-col gap-2.5">
        <CreditsMeter />
        <UpgradeCard />
        <UserMenu />
      </div>
    </div>
  );
}
