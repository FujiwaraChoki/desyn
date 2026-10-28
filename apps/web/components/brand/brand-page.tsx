"use client";

import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  Textarea,
  toast,
  useConfirm,
} from "@desyn/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Copy, MoreHorizontal, Palette, Plus, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Page, PageHeader } from "@/components/app/app-shell";
import { Rich } from "@/components/rich";
import { api, type Id } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { type BrandFont, FontSlot } from "./font-slot";
import { type BrandLogo, LogoUploader } from "./logo-uploader";
import { type BrandColor, PaletteEditor } from "./palette-editor";
import { type BrandVoice, EMPTY_VOICE, VoiceEditor } from "./voice-editor";

type Kit = FunctionReturnType<typeof api.brand.brandKits.list>[number];

interface Draft {
  name: string;
  logos: BrandLogo[];
  colors: BrandColor[];
  fonts: { heading?: BrandFont; body?: BrandFont; accent?: BrandFont };
  voice: BrandVoice;
  rules: string;
}

function toDraft(kit: Kit): Draft {
  const font = (f: Kit["fonts"]["heading"]): BrandFont | undefined =>
    f
      ? {
          family: f.family,
          weight: f.weight,
          style: f.style,
          ...(f.assetId ? { assetId: f.assetId } : {}),
          ...(f.fallback ? { fallback: f.fallback } : {}),
        }
      : undefined;
  const fonts: Draft["fonts"] = {};
  const heading = font(kit.fonts.heading);
  const body = font(kit.fonts.body);
  const accent = font(kit.fonts.accent);
  if (heading) fonts.heading = heading;
  if (body) fonts.body = body;
  if (accent) fonts.accent = accent;
  return {
    name: kit.name,
    logos: kit.logos.map((l) => ({
      id: l.id,
      assetId: l.assetId,
      name: l.name,
      variant: l.variant,
      url: l.url,
    })),
    colors: kit.colors.map((c) => ({
      id: c.id,
      name: c.name,
      value: c.value,
      ...(c.role ? { role: c.role } : {}),
    })),
    fonts,
    voice: kit.voice
      ? { ...kit.voice, ...(kit.voice.sampleCopy ? { sampleCopy: kit.voice.sampleCopy } : {}) }
      : EMPTY_VOICE,
    rules: kit.rules.join("\n"),
  };
}

/** Comparable form of a draft (local preview URLs excluded). */
function signature(d: Draft): string {
  return JSON.stringify({ ...d, logos: d.logos.map(({ url: _url, ...l }) => l) });
}

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-line-subtle py-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
      <div>
        <h2 className="font-serif text-[22px] leading-tight text-fg">{title}</h2>
        <p className="mt-1.5 text-xs leading-5 text-fg-muted">{help}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function KitEditor({ kit, onDeleted }: { kit: Kit; onDeleted: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const { workspaceId } = useApp();
  const update = useMutation(api.brand.brandKits.update);
  const setDefault = useMutation(api.brand.brandKits.setDefault);
  const duplicate = useMutation(api.brand.brandKits.duplicate);
  const remove = useMutation(api.brand.brandKits.delete);
  const original = useMemo(() => toDraft(kit), [kit]);
  const [draft, setDraft] = useState<Draft>(original);
  const [saving, setSaving] = useState(false);
  const dirty = signature(draft) !== signature(original);

  // A server update of the same kit (another tab, a collaborator) resets an untouched editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the kit itself changes
  useEffect(() => {
    if (!dirty) setDraft(original);
  }, [original]);

  const save = async () => {
    setSaving(true);
    try {
      const voice =
        draft.voice.tone ||
        draft.voice.description ||
        draft.voice.keywords.length ||
        draft.voice.avoid.length ||
        draft.voice.sampleCopy
          ? {
              tone: draft.voice.tone,
              description: draft.voice.description,
              keywords: draft.voice.keywords,
              avoid: draft.voice.avoid,
              ...(draft.voice.sampleCopy?.trim() ? { sampleCopy: draft.voice.sampleCopy } : {}),
            }
          : null;
      await update({
        brandKitId: kit.id,
        name: draft.name.trim() || kit.name,
        logos: draft.logos.map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          assetId: l.assetId,
          name: l.name,
          variant: l.variant,
        })),
        colors: draft.colors.map((c) => ({
          ...(c.id ? { id: c.id } : {}),
          name: c.name.trim() || c.value,
          value: c.value,
          ...(c.role ? { role: c.role } : {}),
        })),
        fonts: {
          ...(draft.fonts.heading
            ? {
                heading: {
                  ...draft.fonts.heading,
                  assetId: draft.fonts.heading.assetId as Id<"assets"> | undefined,
                },
              }
            : {}),
          ...(draft.fonts.body
            ? {
                body: {
                  ...draft.fonts.body,
                  assetId: draft.fonts.body.assetId as Id<"assets"> | undefined,
                },
              }
            : {}),
          ...(draft.fonts.accent
            ? {
                accent: {
                  ...draft.fonts.accent,
                  assetId: draft.fonts.accent.assetId as Id<"assets"> | undefined,
                },
              }
            : {}),
        },
        voice,
        rules: draft.rules
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean),
      });
      toast.success(t("brand.saved"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: t("brand.deleteConfirm", { name: kit.name }),
      description: t("brand.deleteBody"),
      confirmLabel: t("brand.delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await remove({ brandKitId: kit.id });
      toast.success(t("brand.deleted", { name: kit.name }));
      onDeleted();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const sample = t("brand.font.preview");
  return (
    <div className="min-w-0 pb-28">
      <div className="flex items-center gap-3 pb-6">
        <Input
          size="lg"
          value={draft.name}
          maxLength={80}
          aria-label={t("brand.sections.name")}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="h-12 max-w-md font-serif text-[26px]"
          inputClassName="font-serif"
        />
        {kit.isDefault ? <Badge tone="accent">{t("brand.default")}</Badge> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t("brand.actions")} variant="secondary" className="ml-auto">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!kit.isDefault ? (
              <DropdownMenuItem
                icon={<Star />}
                onSelect={() =>
                  void setDefault({ brandKitId: kit.id })
                    .then(() => toast.success(t("brand.defaultSet", { name: kit.name })))
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                }
              >
                {t("brand.makeDefault")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              icon={<Copy />}
              onSelect={() =>
                void duplicate({ brandKitId: kit.id })
                  .then(() => toast.success(t("brand.duplicated", { name: kit.name })))
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              {t("brand.duplicate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Trash2 />} destructive onSelect={del}>
              {t("brand.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Section title={t("brand.sections.logos")} help={t("brand.sections.logosHelp")}>
        <LogoUploader
          workspaceId={workspaceId}
          value={draft.logos}
          onChange={(logos) => setDraft((d) => ({ ...d, logos }))}
        />
      </Section>
      <Section title={t("brand.sections.colors")} help={t("brand.sections.colorsHelp")}>
        <PaletteEditor
          value={draft.colors}
          onChange={(colors) => setDraft((d) => ({ ...d, colors }))}
        />
      </Section>
      <Section title={t("brand.sections.fonts")} help={t("brand.sections.fontsHelp")}>
        {/* Heading and body side by side; the accent slot spans the row instead of leaving a hole. */}
        <div className="grid gap-3 xl:grid-cols-2 xl:[&>:last-child]:col-span-2">
          {(["heading", "body", "accent"] as const).map((slot) => (
            <FontSlot
              key={slot}
              label={t(`brand.font.${slot}`)}
              value={draft.fonts[slot]}
              sample={sample}
              onChange={(font) =>
                setDraft((d) => {
                  const fonts = { ...d.fonts };
                  if (font) fonts[slot] = font;
                  else delete fonts[slot];
                  return { ...d, fonts };
                })
              }
            />
          ))}
        </div>
      </Section>
      <Section title={t("brand.sections.voice")} help={t("brand.sections.voiceHelp")}>
        <VoiceEditor value={draft.voice} onChange={(voice) => setDraft((d) => ({ ...d, voice }))} />
      </Section>
      <Section title={t("brand.sections.rules")} help={t("brand.sections.rulesHelp")}>
        <Textarea
          autoResize
          minRows={4}
          value={draft.rules}
          onChange={(e) => setDraft({ ...draft, rules: e.target.value })}
          placeholder={t("brand.sections.rulesPlaceholder")}
          aria-label={t("brand.sections.rules")}
        />
      </Section>
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-[150] flex justify-center px-4 pb-5 transition-[transform,opacity] duration-300 ease-out lg:pl-[252px]",
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-6 opacity-0",
        )}
        aria-hidden={!dirty}
      >
        <div className="flex w-full max-w-lg items-center gap-3 rounded-full border border-line bg-glass py-2 pr-2 pl-5 shadow-popover backdrop-blur-[20px]">
          <span className="flex-1 text-sm text-fg-secondary">{t("brand.unsaved")}</span>
          <Button
            variant="ghost"
            shape="pill"
            onClick={() => setDraft(original)}
            tabIndex={dirty ? 0 : -1}
          >
            {t("brand.discard")}
          </Button>
          <Button
            variant="primary"
            shape="pill"
            loading={saving}
            onClick={save}
            tabIndex={dirty ? 0 : -1}
          >
            {t("brand.saveChanges")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function KitListItem({ kit, active, href }: { kit: Kit; active: boolean; href: string }) {
  const t = useT();
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "block rounded-card p-2.5 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring",
        active ? "bg-fg/[0.07]" : "hover:bg-fg/[0.04]",
      )}
    >
      <div className="flex h-8 overflow-hidden rounded-[6px]">
        {kit.colors.length > 0 ? (
          kit.colors
            .slice(0, 8)
            .map((c) => <span key={c.id} className="flex-1" style={{ background: c.value }} />)
        ) : (
          <span className="flex-1 bg-fg/6" />
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{kit.name}</span>
        {kit.isDefault ? (
          <Badge size="sm" tone="accent">
            {t("brand.default")}
          </Badge>
        ) : null}
      </div>
      <p className="truncate text-2xs text-fg-muted">
        {[kit.fonts.heading?.family, kit.fonts.body?.family].filter(Boolean).join(" · ") || " "}
      </p>
    </Link>
  );
}

export function BrandPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { workspaceId, me, billing, canEdit } = useApp();
  const locked = !me.features.brandKit;
  const kits = useQuery(api.brand.brandKits.list, locked ? "skip" : { workspaceId });
  const create = useMutation(api.brand.brandKits.create);
  const [creating, setCreating] = useState(false);
  const selectedId = search.get("kit");
  const selected = kits?.find((k) => k.id === selectedId) ?? kits?.[0];
  const limit = me.limits.brandKits;

  const newKit = async () => {
    setCreating(true);
    try {
      const id = await create({ workspaceId, name: t("brand.newName") });
      toast.success(t("brand.created"));
      router.replace(`${pathname}?kit=${id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  if (locked) {
    return (
      <Page>
        <PageHeader title={<Rich text={t("brand.title")} />} description={t("brand.subtitle")} />
        <EmptyState
          icon={<Palette />}
          title={<Rich text={t("brand.locked")} />}
          description={t("brand.lockedBody")}
          action={
            billing ? (
              <Button asChild variant="primary">
                <Link href={`${routes.settings("billing")}?upgrade=1`}>{t("common.upgrade")}</Link>
              </Button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  return (
    <Page wide>
      <PageHeader
        title={<Rich text={t("brand.title")} />}
        description={t("brand.subtitle")}
        actions={
          canEdit ? (
            <>
              {kits && limit !== null ? (
                <span className="text-xs text-fg-muted tabular-nums">
                  {t("brand.limit", { used: kits.length, limit })}
                </span>
              ) : null}
              <Button
                variant="primary"
                leadingIcon={<Plus />}
                loading={creating}
                disabled={limit !== null && (kits?.length ?? 0) >= limit}
                onClick={newKit}
              >
                {t("brand.new")}
              </Button>
            </>
          ) : null
        }
      />
      {kits === undefined ? (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-96" />
        </div>
      ) : kits.length === 0 ? (
        <EmptyState
          icon={<Palette />}
          title={<Rich text={t("brand.empty")} />}
          description={t("brand.emptyBody")}
          action={
            canEdit ? (
              <Button variant="primary" leadingIcon={<Plus />} loading={creating} onClick={newKit}>
                {t("brand.new")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav
            aria-label={t("brand.metaTitle")}
            className="flex gap-3 overflow-x-auto pb-1 lg:sticky lg:top-20 lg:flex-col lg:self-start lg:overflow-visible"
          >
            {kits.map((kit) => (
              <div key={kit.id} className="w-56 shrink-0 lg:w-auto">
                <KitListItem
                  kit={kit}
                  active={kit.id === selected?.id}
                  href={`${pathname}?kit=${kit.id}`}
                />
              </div>
            ))}
          </nav>
          {selected ? (
            <KitEditor
              key={selected.id}
              kit={selected}
              onDeleted={() => router.replace(pathname)}
            />
          ) : null}
        </div>
      )}
    </Page>
  );
}
