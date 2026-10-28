"use client";

import { DESIGN_KIND_LIST } from "@desyn/schema/kinds";
import { Button, cn, EmptyState, Input, SegmentedControl, Select, toast } from "@desyn/ui";
import { useConvex, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { LayoutTemplate, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Page, PageHeader } from "@/components/app/app-shell";
import { DesignGridSkeleton, GRID } from "@/components/designs/design-grid";
import { Rich } from "@/components/rich";
import { track } from "@/lib/analytics";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { TemplateCard, type TemplateView } from "./template-card";
import { TemplatePreview } from "./template-preview";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TemplatesPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const convex = useConvex();
  const { me, workspaceId, billing, canEdit } = useApp();
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [sort, setSort] = useState<"popular" | "new">("popular");
  const [kind, setKind] = useState<string>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(params.get("collection"));
  const [search, setSearch] = useState(params.get("q") ?? "");
  const query = useDebounced(search.trim(), 250);
  const [preview, setPreview] = useState<TemplateView | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [using, setUsing] = useState(false);
  const favorite = useMutation(api.templates.templates.favorite);
  const instantiate = useMutation(api.templates.templates.instantiate);
  const categories = useQuery(api.templates.templates.categories, {});
  const collections = useQuery(api.templates.templates.collections, {});
  const kindArg = kind === "all" ? {} : { kind };
  const categoryArg = category ? { category } : {};

  const listing = usePaginatedQuery(
    api.templates.templates.list,
    tab === "all" && !query
      ? { sort, ...kindArg, ...categoryArg, ...(collection ? { collection } : {}) }
      : "skip",
    { initialNumItems: 24 },
  );
  const searching = usePaginatedQuery(
    api.templates.templates.search,
    tab === "all" && query ? { query, ...kindArg, ...categoryArg } : "skip",
    { initialNumItems: 24 },
  );
  const favorites = usePaginatedQuery(
    api.templates.templates.favorites,
    tab === "favorites" ? {} : "skip",
    {
      initialNumItems: 24,
    },
  );
  const active = tab === "favorites" ? favorites : query ? searching : listing;

  // Deep link from the marketing site or onboarding: /templates?preview=<slug>.
  const previewSlug = params.get("preview");
  useEffect(() => {
    if (!previewSlug) return;
    void convex
      .query(api.templates.templates.get, { slug: previewSlug })
      .then((tpl) => {
        setPreview(tpl);
        setPreviewOpen(true);
      })
      .catch(() => {});
  }, [previewSlug, convex]);

  const open = (tpl: TemplateView) => {
    setPreview(tpl);
    setPreviewOpen(true);
    track("template_previewed", { slug: tpl.slug });
  };

  const toggleFavorite = async (tpl: TemplateView) => {
    try {
      await favorite({ templateId: tpl.id, favorite: !tpl.favorite });
      setPreview((p) => (p && p.id === tpl.id ? { ...p, favorite: !tpl.favorite } : p));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const use = async () => {
    if (!preview) return;
    setUsing(true);
    try {
      const { designId } = await instantiate({ templateId: preview.id, workspaceId });
      track("template_used", { slug: preview.slug, premium: preview.premium });
      router.push(routes.design(designId));
    } catch (error) {
      toast.error(errorMessage(error));
      setUsing(false);
    }
  };

  const kindOptions = useMemo(
    () => [
      { value: "all", label: t("templates.allKinds") },
      ...DESIGN_KIND_LIST.filter((k) => k.kind !== "custom").map((k) => ({
        value: k.kind,
        label: k.label,
      })),
    ],
    [t],
  );
  const canUsePreview = preview ? !preview.premium || me.features["templates.premium"] : false;
  const libraryEmpty = categories !== undefined && categories.length === 0;

  return (
    <Page wide>
      <PageHeader
        title={<Rich text={t("templates.title")} />}
        description={t("templates.subtitle")}
      />
      <div className="flex flex-col gap-4">
        <Input
          size="lg"
          leading={<Search />}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (tab !== "all") setTab("all");
          }}
          placeholder={t("templates.searchPlaceholder")}
          aria-label={t("templates.search")}
          className="max-w-2xl rounded-full px-4"
        />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            options={[
              { value: "all", label: t("templates.all") },
              { value: "favorites", label: t("templates.favorites") },
            ]}
            value={tab}
            onValueChange={setTab}
          />
          <Select
            options={kindOptions}
            value={kind}
            onValueChange={setKind}
            aria-label={t("templates.kind")}
            className="w-44"
          />
          {!query && tab === "all" && !collection ? (
            <SegmentedControl
              aria-label={t("templates.sort")}
              options={[
                { value: "popular", label: t("templates.sortPopular") },
                { value: "new", label: t("templates.sortNew") },
              ]}
              value={sort}
              onValueChange={setSort}
            />
          ) : null}
        </div>
        {categories && categories.length > 0 && tab === "all" ? (
          <div className="-mx-1 overflow-x-auto px-1 pb-1 scrollbar-none">
            <ul className="flex gap-1.5">
              {[{ category: null as string | null, count: 0 }, ...categories].map((c) => (
                <li key={c.category ?? "all"}>
                  <button
                    type="button"
                    aria-pressed={category === c.category}
                    onClick={() => {
                      setCategory(c.category);
                      setCollection(null);
                    }}
                    className={cn(
                      "h-8 cursor-pointer rounded-full border px-3.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      category === c.category
                        ? "border-accent/50 bg-accent-tint text-fg"
                        : "border-line-subtle text-fg-secondary hover:border-line hover:text-fg",
                    )}
                  >
                    {c.category ? titleCase(c.category) : t("templates.categoryAll")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {collections && collections.length > 0 && tab === "all" && !query ? (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-serif text-[24px] text-fg">{t("templates.collections")}</h2>
            {collection ? (
              <Button variant="ghost" size="sm" onClick={() => setCollection(null)}>
                {t("templates.clearCollection")}
              </Button>
            ) : null}
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-2 scrollbar-none">
            <ul className="flex gap-3">
              {collections.map((c) => (
                <li key={c.id} className="w-64 shrink-0">
                  <button
                    type="button"
                    aria-pressed={collection === c.slug}
                    onClick={() => {
                      setCollection(collection === c.slug ? null : c.slug);
                      setCategory(null);
                    }}
                    className={cn(
                      "group relative block h-36 w-full cursor-pointer overflow-hidden rounded-[14px] border text-left transition-[border-color,transform] duration-300 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-ring",
                      collection === c.slug
                        ? "border-accent/60"
                        : "border-line-subtle hover:border-line",
                    )}
                  >
                    {c.coverUrl ? (
                      // biome-ignore lint/performance/noImgElement: signed storage URLs
                      <img
                        src={c.coverUrl}
                        alt=""
                        className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-105"
                      />
                    ) : (
                      // A color is not valid inside background-image: the surface goes on background-color.
                      <span className="absolute inset-0 bg-surface-2 bg-[radial-gradient(120%_100%_at_0%_0%,rgb(var(--accent-rgb)/0.32),transparent_62%),radial-gradient(80%_70%_at_100%_100%,rgb(var(--accent-rgb)/0.10),transparent_70%)]" />
                    )}
                    <span className="absolute inset-0 bg-[linear-gradient(180deg,transparent_30%,rgb(0_0_0/0.75))]" />
                    <span className="absolute inset-x-3.5 bottom-3">
                      <span className="block font-serif text-xl leading-tight text-white">
                        {c.title}
                      </span>
                      <span className="block text-2xs text-white/75">
                        {t("templates.collectionCount", { count: c.count })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        {active.status === "LoadingFirstPage" ? (
          <DesignGridSkeleton count={12} />
        ) : active.results.length === 0 ? (
          <EmptyState
            icon={<LayoutTemplate />}
            title={
              <Rich
                text={
                  tab === "favorites"
                    ? t("templates.emptyFavorites")
                    : libraryEmpty
                      ? t("templates.noLibrary")
                      : t("templates.empty")
                }
              />
            }
            description={
              tab === "favorites"
                ? t("templates.emptyFavoritesBody")
                : libraryEmpty
                  ? t("templates.noLibraryBody")
                  : t("templates.emptyBody")
            }
            action={
              libraryEmpty && tab === "all" ? (
                <Button variant="primary" onClick={() => router.push(`${routes.home}#create`)}>
                  {t("dashboard.create.title")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-8">
            <div className={GRID}>
              {active.results.map((tpl, i) => (
                <TemplateCard
                  key={tpl.id}
                  template={tpl}
                  index={i}
                  onOpen={() => open(tpl)}
                  onFavorite={() => toggleFavorite(tpl)}
                  canFavorite
                />
              ))}
            </div>
            {active.status === "CanLoadMore" || active.status === "LoadingMore" ? (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  loading={active.status === "LoadingMore"}
                  onClick={() => active.loadMore(24)}
                >
                  {t("templates.loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
      <TemplatePreview
        template={preview}
        open={previewOpen}
        onOpenChange={(o) => {
          setPreviewOpen(o);
          if (!o && previewSlug) router.replace(pathname);
        }}
        canUse={canUsePreview && canEdit}
        billing={billing}
        using={using}
        onUse={use}
        onFavorite={() => preview && toggleFavorite(preview)}
      />
    </Page>
  );
}
