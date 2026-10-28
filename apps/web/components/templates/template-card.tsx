"use client";

import { cn, ProBadge } from "@desyn/ui";
import type { FunctionReturnType } from "convex/server";
import { Heart } from "lucide-react";
import { DesignThumb } from "@/components/designs/design-thumb";
import { kindLabel } from "@/components/designs/kind-icon";
import type { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";

export type TemplateView = FunctionReturnType<
  typeof api.templates.templates.search
>["page"][number];

export function TemplateCard({
  template,
  index,
  onOpen,
  onFavorite,
  canFavorite,
}: {
  template: TemplateView;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
  canFavorite: boolean;
}) {
  const t = useT();
  const thumb = template.thumbnails[0];
  return (
    <article
      className="rise group relative flex flex-col gap-2"
      style={{ ["--i" as string]: Math.min(index, 12) }}
    >
      {/* The ::after layer stretches the button over the whole card so the title opens it too. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("templates.preview", { title: template.title })}
        className="block cursor-pointer rounded-[10px] text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <DesignThumb
          width={thumb?.width ?? template.width}
          height={thumb?.height ?? template.height}
          thumbnailUrl={thumb?.url ?? null}
          kind={template.kind}
          name={template.title}
        />
      </button>
      {template.premium ? <ProBadge className="absolute top-2 left-2" /> : null}
      {canFavorite ? (
        <button
          type="button"
          onClick={onFavorite}
          aria-pressed={template.favorite}
          aria-label={template.favorite ? t("templates.unfavorite") : t("templates.favorite")}
          className={cn(
            "absolute top-1.5 right-1.5 grid size-8 cursor-pointer place-items-center rounded-full bg-glass backdrop-blur-md transition-[opacity,color] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
            template.favorite
              ? "text-accent opacity-100"
              : "text-fg-secondary hover:text-fg sm:opacity-0 sm:group-hover:opacity-100",
          )}
        >
          <Heart className={cn("size-4", template.favorite && "fill-current")} />
        </button>
      ) : null}
      <div className="px-1">
        <h3 className="truncate text-sm font-medium text-fg">{template.title}</h3>
        <p className="truncate text-2xs text-fg-muted">
          {kindLabel(template.kind)}
          {template.pageCount > 1
            ? ` · ${t("templates.pages", { count: template.pageCount })}`
            : ""}
        </p>
      </div>
    </article>
  );
}
