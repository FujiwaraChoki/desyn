"use client";

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  IconButton,
  ProBadge,
} from "@desyn/ui";
import { ArrowRight, ChevronLeft, ChevronRight, Heart } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DesignThumb } from "@/components/designs/design-thumb";
import { kindLabel } from "@/components/designs/kind-icon";
import { formatSize } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import type { TemplateView } from "./template-card";

/** Large preview of a template: page carousel, details, favorite and "Use template". */
export function TemplatePreview({
  template,
  open,
  onOpenChange,
  canUse,
  billing,
  using,
  onUse,
  onFavorite,
}: {
  template: TemplateView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canUse: boolean;
  billing: boolean;
  using: boolean;
  onUse: () => void;
  onFavorite: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to the first page per template
  useEffect(() => setPage(0), [template?.id]);
  if (!template) return null;
  const pages = template.thumbnails.length > 0 ? template.thumbnails : [null];
  const current = pages[Math.min(page, pages.length - 1)] ?? null;
  const total = pages.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-w-5xl">
        <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
          <div className="relative bg-canvas p-6 dot-grid md:p-10">
            <DesignThumb
              width={current?.width ?? template.width}
              height={current?.height ?? template.height}
              thumbnailUrl={current?.url ?? null}
              kind={template.kind}
              name={template.title}
              className="aspect-[4/3] bg-transparent [background-image:none]"
            />
            {total > 1 ? (
              <div className="mt-4 flex items-center justify-center gap-3">
                <IconButton
                  label={t("templates.prev")}
                  size="sm"
                  variant="secondary"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft />
                </IconButton>
                <span className="text-xs text-fg-muted tabular-nums">
                  {t("templates.pageOf", { current: page + 1, total })}
                </span>
                <IconButton
                  label={t("templates.next")}
                  size="sm"
                  variant="secondary"
                  disabled={page >= total - 1}
                  onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
                >
                  <ChevronRight />
                </IconButton>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-5 p-6 md:p-8">
            <div>
              {template.premium ? <ProBadge className="mb-3" /> : null}
              <DialogTitle className="pr-8">{template.title}</DialogTitle>
              {template.description ? (
                <DialogDescription className="mt-2 leading-6">
                  {template.description}
                </DialogDescription>
              ) : null}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-muted">{t("templates.kind")}</dt>
              <dd className="text-fg">{kindLabel(template.kind)}</dd>
              <dt className="text-fg-muted">{t("templates.size")}</dt>
              <dd className="text-fg tabular-nums">
                {formatSize(Math.round(template.width), Math.round(template.height))}
              </dd>
              <dt className="text-fg-muted">{t("templates.details")}</dt>
              <dd className="text-fg">{t("templates.pages", { count: template.pageCount })}</dd>
            </dl>
            {template.tags.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label={t("templates.tags")}>
                {template.tags.slice(0, 12).map((tag) => (
                  <li key={tag}>
                    <Badge tone="neutral">{tag}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-auto flex flex-col gap-2 pt-2">
              {canUse ? (
                <Button
                  variant="primary"
                  size="lg"
                  loading={using}
                  leadingIcon={<ArrowRight />}
                  onClick={onUse}
                >
                  {t("templates.use")}
                </Button>
              ) : (
                <>
                  <p className="text-sm text-fg-muted">{t("templates.premiumNote")}</p>
                  {billing ? (
                    <Button asChild variant="primary" size="lg">
                      <Link href={`${routes.settings("billing")}?upgrade=1`}>
                        {t("templates.upgradeToUse")}
                      </Link>
                    </Button>
                  ) : null}
                </>
              )}
              <Button
                variant="secondary"
                size="lg"
                leadingIcon={
                  <Heart className={template.favorite ? "fill-current text-accent" : undefined} />
                }
                onClick={onFavorite}
              >
                {template.favorite ? t("templates.unfavorite") : t("templates.favorite")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
