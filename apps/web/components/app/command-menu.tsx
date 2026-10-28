"use client";

import { CommandEmpty, CommandGroup, CommandItem, CommandPalette } from "@desyn/ui";
import { usePaginatedQuery } from "convex/react";
import {
  FolderClosed,
  FolderPlus,
  House,
  LayoutTemplate,
  MessageSquareText,
  Palette,
  Plus,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KindIcon, kindLabel } from "@/components/designs/kind-icon";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { useApp } from "./app-context";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** ⌘K: search designs in the workspace and jump anywhere. */
export function CommandMenu({
  open,
  onOpenChange,
  onCreate,
  onNewFolder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: () => void;
  onNewFolder: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const { workspaceId } = useApp();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 150);
  const { results } = usePaginatedQuery(
    api.designs.designs.list,
    open ? { workspaceId, filter: "all", ...(query ? { search: query } : {}) } : "skip",
    { initialNumItems: 8 },
  );

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const q = search.trim().toLowerCase();
  const nav = [
    { label: t("app.nav.home"), href: routes.home, icon: <House /> },
    { label: t("app.nav.projects"), href: routes.projects, icon: <FolderClosed /> },
    { label: t("app.nav.templates"), href: routes.templates, icon: <LayoutTemplate /> },
    { label: t("app.nav.brand"), href: routes.brand, icon: <Palette /> },
    { label: t("app.nav.shared"), href: routes.shared, icon: <Users /> },
    { label: t("app.nav.trash"), href: routes.trash, icon: <Trash2 /> },
    { label: t("app.nav.settings"), href: routes.settings("profile"), icon: <Settings /> },
  ].filter((n) => !q || n.label.toLowerCase().includes(q));
  const actions = [
    { label: t("app.search.createDesign"), icon: <Plus />, run: onCreate },
    {
      label: t("app.search.describe"),
      icon: <MessageSquareText />,
      run: () => go(`${routes.home}#describe`),
    },
    { label: t("app.search.newFolder"), icon: <FolderPlus />, run: onNewFolder },
  ].filter((a) => !q || a.label.toLowerCase().includes(q));

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      search={search}
      onSearchChange={setSearch}
      shouldFilter={false}
      placeholder={t("app.search.placeholder")}
      title={t("app.search.button")}
    >
      <CommandEmpty>{t("app.search.empty", { query: search })}</CommandEmpty>
      {results.length > 0 ? (
        <CommandGroup heading={t("app.search.designs")}>
          {results.map((d) => (
            <CommandItem
              key={d.id}
              value={`design-${d.id}`}
              icon={<KindIcon kind={d.kind} />}
              hint={kindLabel(d.kind)}
              onSelect={() => go(routes.design(d.id))}
            >
              {d.name || t("common.untitled")}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {actions.length > 0 ? (
        <CommandGroup heading={t("app.search.actions")}>
          {actions.map((a) => (
            <CommandItem
              key={a.label}
              value={`action-${a.label}`}
              icon={a.icon}
              onSelect={() => {
                onOpenChange(false);
                a.run();
              }}
            >
              {a.label}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {nav.length > 0 ? (
        <CommandGroup heading={t("app.search.navigate")}>
          {nav.map((n) => (
            <CommandItem
              key={n.href}
              value={`nav-${n.href}`}
              icon={n.icon}
              onSelect={() => go(n.href)}
            >
              {n.label}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </CommandPalette>
  );
}
