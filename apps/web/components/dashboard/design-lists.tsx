"use client";

import { EmptyState } from "@desyn/ui";
import { usePaginatedQuery } from "convex/react";
import { Trash2, Users } from "lucide-react";
import { useApp } from "@/components/app/app-context";
import { Page, PageHeader } from "@/components/app/app-shell";
import { DesignGrid } from "@/components/designs/design-grid";
import { Rich } from "@/components/rich";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";

export function SharedWithMe() {
  const t = useT();
  const { results, status, loadMore } = usePaginatedQuery(
    api.designs.designs.list,
    { filter: "shared" },
    { initialNumItems: 24 },
  );
  return (
    <Page>
      <PageHeader
        title={t("dashboard.shared.title")}
        description={t("dashboard.shared.subtitle")}
      />
      <DesignGrid
        designs={results}
        status={status}
        loadMore={loadMore}
        mode="shared"
        empty={
          <EmptyState
            icon={<Users />}
            title={<Rich text={t("dashboard.shared.empty")} />}
            description={t("dashboard.shared.emptyBody")}
          />
        }
      />
    </Page>
  );
}

export function Trash() {
  const t = useT();
  const { workspaceId } = useApp();
  const { results, status, loadMore } = usePaginatedQuery(
    api.designs.designs.list,
    { workspaceId, filter: "trash" },
    { initialNumItems: 24 },
  );
  return (
    <Page>
      <PageHeader title={t("dashboard.trash.title")} description={t("dashboard.trash.subtitle")} />
      <DesignGrid
        designs={results}
        status={status}
        loadMore={loadMore}
        mode="trash"
        empty={
          <EmptyState
            icon={<Trash2 />}
            title={<Rich text={t("dashboard.trash.empty")} />}
            description={t("dashboard.trash.emptyBody")}
          />
        }
      />
    </Page>
  );
}
