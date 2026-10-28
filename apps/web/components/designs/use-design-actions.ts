"use client";

import { toast, useConfirm } from "@desyn/ui";
import { useConvex, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";

export type DesignSummary = FunctionReturnType<typeof api.designs.designs.list>["page"][number];

/** The mutations behind a design card's menu, with toasts and undo in the product voice. */
export function useDesignActions() {
  const t = useT();
  const router = useRouter();
  const confirm = useConfirm();
  const rename = useMutation(api.designs.designs.rename);
  const duplicate = useMutation(api.designs.designs.duplicate);
  const trash = useMutation(api.designs.designs.delete);
  const restore = useMutation(api.designs.designs.restore);
  const purge = useMutation(api.designs.designs.purge);
  const move = useMutation(api.designs.designs.moveToFolder);
  const setShare = useMutation(api.designs.designs.setShare);
  const convex = useConvex();

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  return {
    open: (d: DesignSummary) => router.push(routes.design(d.id)),
    present: (d: DesignSummary) => router.push(routes.present(d.id)),
    rename: (d: DesignSummary, name: string) =>
      rename({ designId: d.id, name }).then(() => {
        toast.success(t("dashboard.renamed"));
      }),
    duplicate: (d: DesignSummary) =>
      run(async () => {
        const result = await duplicate({ designId: d.id });
        if (result.pending) toast.info(t("dashboard.duplicatePending"));
        else toast.success(t("dashboard.duplicated", { name: d.name }));
      }),
    trash: (d: DesignSummary) =>
      run(async () => {
        await trash({ designId: d.id });
        toast(t("dashboard.trashed", { name: d.name }), {
          action: {
            label: t("dashboard.undo"),
            onClick: () => void run(() => restore({ designId: d.id })),
          },
        });
      }),
    restore: (d: DesignSummary) =>
      run(async () => {
        await restore({ designId: d.id });
        toast.success(t("dashboard.restored", { name: d.name }));
      }),
    purge: async (d: DesignSummary) => {
      const ok = await confirm({
        title: t("dashboard.purgeConfirm", { name: d.name }),
        description: t("dashboard.purgeBody"),
        confirmLabel: t("dashboard.card.deleteForever"),
        tone: "danger",
      });
      if (!ok) return;
      await run(async () => {
        await purge({ designId: d.id });
        toast.success(t("dashboard.purged", { name: d.name }));
      });
    },
    /** Copies a view-only link, reusing an existing open (no password, unexpired) view link. */
    copyLink: (d: DesignSummary) =>
      run(async () => {
        const shares = await convex.query(api.designs.designs.listShares, { designId: d.id });
        const open = shares.find((s) => s.permission === "view" && !s.hasPassword && !s.expired);
        const url = open?.url ?? (await setShare({ designId: d.id, permission: "view" })).url;
        await navigator.clipboard.writeText(url);
        toast.success(t("dashboard.card.linkCopied"), { description: url });
      }),
    move: (d: DesignSummary, folderId: Id<"folders"> | null, folderName: string | null) =>
      run(async () => {
        await move({ designId: d.id, folderId });
        toast.success(
          folderName
            ? t("dashboard.moved", { name: d.name, folder: folderName })
            : t("dashboard.movedRoot", { name: d.name }),
        );
      }),
  };
}
