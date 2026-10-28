"use client";

import { Button, EmptyState, Eyebrow, SunGlow } from "@desyn/ui";
import { usePaginatedQuery, useQuery } from "convex/react";
import { ArrowRight, LayoutTemplate, Shapes } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Page } from "@/components/app/app-shell";
import { DesignGrid } from "@/components/designs/design-grid";
import { Rich } from "@/components/rich";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { AiPrompt } from "./ai-prompt";
import { CreateBar } from "./create-bar";
import { FOLDER_GRID, FolderCard } from "./folder-cards";
import { useIntentRedirect } from "./use-intent";

function greetingKey(hour: number) {
  if (hour < 5) return "dashboard.greeting.night" as const;
  if (hour < 12) return "dashboard.greeting.morning" as const;
  if (hour < 18) return "dashboard.greeting.afternoon" as const;
  return "dashboard.greeting.evening" as const;
}

export function Home() {
  const t = useT();
  const { me, workspaceId } = useApp();
  useIntentRedirect();
  // The greeting depends on the visitor's clock: computed after mount to keep hydration stable.
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => setHour(new Date().getHours()), []);
  const firstName = (me.name || me.email).split(/[\s@]/)[0] ?? "";
  const folders = useQuery(api.accounts.folders.list, { workspaceId });
  const rootFolders = (folders ?? []).filter((f) => f.parentId === null);
  const { results, status, loadMore } = usePaginatedQuery(
    api.designs.designs.list,
    { workspaceId, filter: "recent" },
    { initialNumItems: 24 },
  );

  return (
    <div className="relative overflow-hidden">
      <SunGlow width={1100} height={420} strength={0.12} className="top-0" />
      <Page>
        <section
          id="describe"
          className="relative mx-auto max-w-[760px] pt-4 pb-10 text-center sm:pt-10"
        >
          <h1 className="rich-title rise font-serif text-[40px] leading-[1.04] tracking-[-0.015em] text-fg sm:text-[60px]">
            {hour === null ? " " : <Rich text={t(greetingKey(hour), { name: firstName })} />}
          </h1>
          <p className="rise mt-3 text-base text-fg-muted" style={{ ["--i" as string]: 1 }}>
            {t("dashboard.subtitle")}
          </p>
          <div className="rise mt-8 text-left" style={{ ["--i" as string]: 2 }}>
            <AiPrompt />
          </div>
        </section>

        <section id="create" className="rise scroll-mt-24" style={{ ["--i" as string]: 3 }}>
          <Eyebrow>{t("dashboard.create.title")}</Eyebrow>
          <div className="mt-3">
            <CreateBar />
          </div>
        </section>

        {rootFolders.length > 0 ? (
          <section className="mt-12">
            <div className="mb-4 flex items-center justify-between">
              <Eyebrow>{t("dashboard.folders.title")}</Eyebrow>
              <Button asChild variant="ghost" size="sm" trailingIcon={<ArrowRight />}>
                <Link href={routes.projects}>{t("dashboard.recent.viewAll")}</Link>
              </Button>
            </div>
            <div className={FOLDER_GRID}>
              {rootFolders.slice(0, 8).map((f, i) => (
                <FolderCard key={f.id} folder={f} all={folders ?? []} index={i} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-12">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-serif text-[28px] leading-tight text-fg">
              {t("dashboard.recent.title")}
            </h2>
            <Button asChild variant="ghost" size="sm" trailingIcon={<ArrowRight />}>
              <Link href={routes.projects}>{t("dashboard.recent.viewAll")}</Link>
            </Button>
          </div>
          <DesignGrid
            designs={results}
            status={status}
            loadMore={loadMore}
            empty={
              <EmptyState
                icon={<Shapes />}
                title={<Rich text={t("dashboard.recent.empty")} />}
                description={t("dashboard.recent.emptyBody")}
                action={
                  <Button asChild leadingIcon={<LayoutTemplate />}>
                    <Link href={routes.templates}>{t("dashboard.recent.browseTemplates")}</Link>
                  </Button>
                }
              />
            }
          />
        </section>
      </Page>
    </div>
  );
}
