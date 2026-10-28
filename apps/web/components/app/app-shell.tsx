"use client";

import {
  Button,
  IconButton,
  Logo,
  Sheet,
  SheetContent,
  SheetTitle,
  Shortcut,
  toast,
} from "@desyn/ui";
import { useMutation } from "convex/react";
import { Menu, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { useApp } from "./app-context";
import { CommandMenu } from "./command-menu";
import { PromptDialog } from "./prompt-dialog";
import { Sidebar } from "./sidebar";
import { VerifyBanner } from "./verify-banner";

/** Dashboard frame: sidebar (a sheet on phones), a slim top bar with search and create, content. */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const { workspaceId, canEdit } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const createFolder = useMutation(api.accounts.folders.create);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile nav whenever the route changes
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const createDesign = () => {
    if (pathname === routes.home) {
      document.getElementById("create")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else router.push(`${routes.home}#create`);
  };

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="hidden w-[252px] shrink-0 border-r border-line-subtle bg-surface-1 lg:block">
        <div className="sticky top-0 h-dvh">
          <Sidebar />
        </div>
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-[284px] p-0" showClose={false}>
          <SheetTitle className="sr-only">{t("app.nav.label")}</SheetTitle>
          <Sidebar onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-[100] flex h-14 items-center gap-2 border-b border-line-subtle bg-background/80 px-4 backdrop-blur-xl sm:px-6">
          <IconButton
            label={t("app.nav.openMenu")}
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
          >
            <Menu />
          </IconButton>
          <Link href="/" className="mr-1 lg:hidden" aria-label="Desyn">
            <Logo variant="mark" size={20} />
          </Link>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-9 w-full max-w-md cursor-pointer items-center gap-2 rounded-full border border-line-subtle bg-surface-1 px-3.5 text-sm text-fg-muted transition-colors hover:border-line hover:text-fg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Search className="size-4" />
            <span className="flex-1 truncate text-left">{t("app.search.placeholder")}</span>
            <Shortcut keys="mod+k" className="hidden sm:inline-flex" />
          </button>
          <div className="ml-auto flex items-center gap-2">
            {canEdit ? (
              <Button variant="primary" shape="pill" leadingIcon={<Plus />} onClick={createDesign}>
                <span className="hidden sm:inline">{t("dashboard.create.title")}</span>
              </Button>
            ) : null}
          </div>
        </header>
        <VerifyBanner />
        <main className="relative min-w-0 flex-1">{children}</main>
      </div>
      <CommandMenu
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onCreate={createDesign}
        onNewFolder={() => setFolderOpen(true)}
      />
      <PromptDialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        title={t("dashboard.newFolderTitle")}
        label={t("dashboard.folderName")}
        placeholder={t("dashboard.folderPlaceholder")}
        submitLabel={t("common.create")}
        maxLength={80}
        onSubmit={async (name) => {
          const id = await createFolder({ workspaceId, name });
          toast.success(t("dashboard.folderCreated", { name }));
          router.push(routes.folder(id));
        }}
      />
    </div>
  );
}

/** Centered page column with the design system's generous rhythm. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={
        wide
          ? "mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-8 lg:py-10"
          : "mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-8 lg:py-10"
      }
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
        <h1 className="rich-title rise font-serif text-[36px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[44px]">
          {title}
        </h1>
        {description ? (
          <p className="rise mt-2 text-sm text-fg-muted" style={{ ["--i" as string]: 1 }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
