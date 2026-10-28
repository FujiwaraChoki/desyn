"use client";

import { pages as listPages, setFill } from "@desyn/doc-ops";
import { type AssetRef, createImage, createSvg } from "@desyn/schema";
import { Button, Checkbox, ProBadge, Select, Swatch, Tooltip } from "@desyn/ui";
import { ExternalLink, ImageOff, Palette, Stamp } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectedIds } from "../../commands/helpers.ts";
import { useCommand, useEditor, useEditorStore } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import { assetRefFromView } from "../../sync/assets.ts";
import {
  type BrandFont,
  type BrandKitView,
  type BrandLogo,
  errorMessage,
  refs,
  useBackendQuery,
  useWorkspaceId,
} from "../backend.ts";
import { askAi, hasAiDock } from "../lib/ai.ts";
import { applyBrandTransaction } from "../lib/brand-apply.ts";
import { TEXT_PRESETS, textFromPreset } from "../lib/catalog.ts";
import { loadPreviewFont } from "../lib/fonts.ts";
import { useGate } from "../lib/gate.ts";
import { assetOps, fitToPage, insertSubtree } from "../lib/insert.ts";
import { updateEach } from "../lib/ops.ts";
import { pageInk } from "../lib/page-color.ts";
import {
  PanelBody,
  PanelEmpty,
  PanelSection,
  Tile,
  TileGrid,
  TileSkeletons,
} from "../ui/primitives.tsx";

/**
 * Brand: the workspace's brand kits. Colors paint the selection, fonts restyle selected text (or add text in
 * that font), logos are placed on the page, and "Apply brand" restyles the page or the whole design with the
 * kit (lib/brand-apply.ts). "Match with AI" hands the job to the agent for a judgement-based restyle.
 */

/**
 * Font assets of custom brand fonts (uploaded font files) the design lacks. Text that switches to such a
 * family needs its `AssetRef` in the design, or the engine (and every other client) falls back to another
 * face. Catalog fonts have no asset and load by family name.
 */
export async function brandFontAssets(
  editor: EditorController,
  fonts: (BrandFont | undefined)[],
): Promise<AssetRef[]> {
  const convex = editor.convex;
  if (!convex) return [];
  const out: AssetRef[] = [];
  for (const font of fonts) {
    if (!font?.assetId) continue;
    if (font.refId && editor.design?.assets[font.refId]) continue;
    const view = await convex.query(refs.assetsGet, { assetId: font.assetId });
    const ref: AssetRef = { ...assetRefFromView(view), source: "brand" };
    if (ref.kind !== "font") continue;
    if (view.url) editor.assets.prime(ref.id, view.url);
    out.push(ref);
  }
  return out;
}

export function BrandPanel() {
  const editor = useEditor();
  const gate = useGate();
  const workspaceId = useWorkspaceId();
  const kits = useBackendQuery(refs.brandList, workspaceId ? { workspaceId } : "skip");
  const designKit = useEditorStore((s) => s.doc.design?.brandKitId ?? null);
  const [kitId, setKitId] = useState<string | null>(null);
  const list = kits.data ?? [];
  const kit = list.find((k) => k.id === (kitId ?? designKit)) ?? list[0];

  if (kits.status === "unavailable") {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<Stamp />}
          title={
            <>
              your brand, <em className="text-accent">everywhere</em>
            </>
          }
          description="Brand kits live in your Desyn workspace. Open the design in the app to use them."
        />
      </PanelBody>
    );
  }
  if (kits.status === "error" && list.length === 0) {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<Stamp />}
          title={
            <>
              brand kits are <em className="text-accent">out of reach</em>
            </>
          }
          description={kits.error ? errorMessage(kits.error) : "Try again in a moment."}
        />
      </PanelBody>
    );
  }
  if (kits.status === "loading" && list.length === 0) {
    return (
      <PanelBody>
        <div className="flex flex-col gap-3 pt-2">
          <TileGrid min={36}>
            <TileSkeletons count={8} />
          </TileGrid>
          <TileGrid min={120}>
            <TileSkeletons count={2} ratio={2.2} />
          </TileGrid>
        </div>
      </PanelBody>
    );
  }
  if (!kit) {
    return (
      <PanelBody>
        <PanelEmpty
          icon={<Stamp />}
          title={
            <>
              no brand kit <em className="text-accent">yet</em>
            </>
          }
          description="Save your colors, fonts and logos once, then apply them to any design in a click."
          action={
            <div className="flex flex-col items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Palette />}
                onClick={() => editor.navigate("/brand")}
              >
                Create a brand kit
              </Button>
              {gate.locked("brandKit") ? <ProBadge /> : null}
            </div>
          }
        />
      </PanelBody>
    );
  }
  return (
    <PanelBody>
      {list.length > 1 ? (
        <div className="pt-1">
          <Select
            aria-label="Brand kit"
            size="sm"
            value={kit.id}
            onValueChange={setKitId}
            options={list.map((k) => ({
              value: k.id,
              label: k.isDefault ? `${k.name} (default)` : k.name,
            }))}
          />
        </div>
      ) : (
        <p className="pt-1 font-serif text-xl text-fg">{kit.name}</p>
      )}
      <ApplyBrand kit={kit} />
      <BrandColors kit={kit} />
      <BrandFonts kit={kit} />
      <BrandLogos kit={kit} />
      {kit.voice ? (
        <PanelSection title="Voice">
          <div className="rounded-[10px] bg-surface-2 p-3 text-xs text-fg-secondary">
            <p className="text-fg">{kit.voice.tone}</p>
            {kit.voice.keywords.length > 0 ? (
              <p className="mt-1.5 text-fg-muted">{kit.voice.keywords.join(" · ")}</p>
            ) : null}
          </div>
        </PanelSection>
      ) : null}
      <div className="pt-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          trailingIcon={<ExternalLink />}
          onClick={() => editor.navigate("/brand")}
        >
          Manage brand kits
        </Button>
      </div>
    </PanelBody>
  );
}

function ApplyBrand({ kit }: { kit: BrandKitView }) {
  const editor = useEditor();
  const canEdit = useEditorStore((s) => s.mode === "edit");
  const matchBrand = useCommand("ai.matchBrand");
  const [colors, setColors] = useState(true);
  const [fonts, setFonts] = useState(true);
  const spec = {
    colors: kit.colors,
    fonts: {
      ...(kit.fonts.heading ? { heading: kit.fonts.heading } : {}),
      ...(kit.fonts.body ? { body: kit.fonts.body } : {}),
    },
  };
  const apply = async (scope: "page" | "all") => {
    let assets: AssetRef[] = [];
    try {
      assets = fonts ? await brandFontAssets(editor, [kit.fonts.heading, kit.fonts.body]) : [];
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't load the brand fonts",
        description: errorMessage(e),
      });
      return;
    }
    await editor.apply(
      (design, s) => {
        const roots =
          scope === "page" ? (s.pageId ? [s.pageId] : []) : listPages(design).map((p) => p.id);
        const tx = applyBrandTransaction(design, roots, spec, {
          colors,
          fonts,
          brandKitId: kit.id,
        });
        return [...assetOps(design, assets), ...tx.ops];
      },
      { label: scope === "page" ? "Apply brand to page" : "Apply brand to design" },
    );
  };
  return (
    <PanelSection title="Apply brand">
      <div className="flex flex-col gap-2.5 rounded-[12px] bg-surface-2 p-3">
        <div className="flex gap-4">
          <Checkbox
            label="Colors"
            checked={colors}
            onCheckedChange={(v) => setColors(v === true)}
          />
          <Checkbox label="Fonts" checked={fonts} onCheckedChange={(v) => setFonts(v === true)} />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={!canEdit || (!colors && !fonts)}
            onClick={() => void apply("page")}
          >
            This page
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!canEdit || (!colors && !fonts)}
            onClick={() => void apply("all")}
          >
            All pages
          </Button>
        </div>
        {matchBrand.exists || hasAiDock(editor) ? (
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<Palette className="text-accent" />}
            disabled={!canEdit}
            onClick={() => {
              // The AI extension's own command knows the active kit; otherwise hand the request to the dock.
              if (matchBrand.exists) void matchBrand.run();
              else
                askAi(
                  editor,
                  `Make this design match my brand kit "${kit.name}": its colors, fonts, logo and voice. Keep the layout.`,
                  { autoStart: true, scope: "design" },
                );
            }}
          >
            Match with AI
          </Button>
        ) : null}
      </div>
    </PanelSection>
  );
}

function BrandColors({ kit }: { kit: BrandKitView }) {
  const editor = useEditor();
  const ids = useEditorStore(useShallow((s) => s.selection));
  if (kit.colors.length === 0) return null;
  const paint = (value: string) => {
    if (!editor.canEdit) return;
    const targets = selectedIds(editor);
    if (targets.length === 0) {
      editor.notify({
        kind: "info",
        title: "Select a layer to paint it",
        description: "Or apply the brand to the whole page above.",
      });
      return;
    }
    void editor.apply((design) => setFill(design, targets, { type: "solid", color: value }), {
      label: "Brand color",
    });
  };
  return (
    <PanelSection title="Colors">
      <div className="flex flex-wrap gap-2">
        {kit.colors.map((c) => (
          <Tooltip
            key={c.id}
            content={`${c.name}${c.role ? ` · ${c.role}` : ""} · ${c.value.toUpperCase()}`}
          >
            <span>
              <Swatch
                color={c.value}
                label={`${c.name} ${c.value}`}
                onSelect={paint}
                className="size-8 rounded-[8px]"
              />
            </span>
          </Tooltip>
        ))}
      </div>
      {ids.length === 0 ? (
        <p className="text-2xs text-fg-muted">Select layers, then pick a color.</p>
      ) : null}
    </PanelSection>
  );
}

const SLOT_LABEL = { heading: "Heading", body: "Body", accent: "Accent" } as const;

function FontCard({ slot, font }: { slot: "heading" | "body" | "accent"; font: BrandFont }) {
  const editor = useEditor();
  const textIds = useEditorStore(
    useShallow((s) => s.selection.filter((id) => s.doc.design?.nodes[id]?.type === "text")),
  );
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void loadPreviewFont(font.family, font.weight).then(() => setReady(true));
  }, [font.family, font.weight]);
  const use = async () => {
    if (!editor.canEdit) return;
    let assets: AssetRef[];
    try {
      assets = await brandFontAssets(editor, [font]);
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't load the brand font",
        description: errorMessage(e),
      });
      return;
    }
    if (textIds.length > 0) {
      await editor.apply(
        (design) => [
          ...assetOps(design, assets),
          ...updateEach(design, textIds, (n) =>
            n.type === "text"
              ? {
                  style: {
                    ...n.style,
                    fontFamily: font.family,
                    fontWeight: font.weight,
                    fontStyle: font.style,
                  },
                  runs: n.runs.map((r) => {
                    if (!r.style) return r;
                    const { fontFamily: _f, fontWeight: _w, fontStyle: _s, ...rest } = r.style;
                    return Object.keys(rest).length > 0 ? { ...r, style: rest } : { text: r.text };
                  }),
                }
              : null,
          ),
        ],
        { label: "Brand font" },
      );
      return;
    }
    const preset = TEXT_PRESETS.find(
      (p) => p.id === (slot === "body" ? "body" : slot === "accent" ? "subheading" : "heading"),
    );
    if (!preset) return;
    const node = textFromPreset(preset, font.family, pageInk(editor));
    node.style.fontWeight = font.weight;
    node.style.fontStyle = font.style;
    await insertSubtree(editor, [node], { label: "Add brand text", assets });
  };
  return (
    <button
      type="button"
      onClick={() => void use()}
      disabled={!editor.canEdit}
      className="group flex w-full cursor-pointer flex-col gap-0.5 rounded-[12px] bg-surface-2 px-3.5 py-3 text-left transition-[background-color] duration-200 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-2xs text-fg-muted">{SLOT_LABEL[slot]}</span>
      <span
        className="truncate text-xl text-fg transition-opacity duration-300"
        style={{
          fontFamily: `"${font.family}", ui-sans-serif, system-ui`,
          fontWeight: font.weight,
          fontStyle: font.style,
          opacity: ready ? 1 : 0.7,
        }}
      >
        {font.family}
      </span>
      <span className="text-2xs text-fg-muted">
        {textIds.length > 0 ? "Apply to selected text" : "Add text in this font"}
      </span>
    </button>
  );
}

function BrandFonts({ kit }: { kit: BrandKitView }) {
  const slots = (["heading", "body", "accent"] as const).filter((s) => kit.fonts[s]);
  if (slots.length === 0) return null;
  return (
    <PanelSection title="Fonts">
      <div className="flex flex-col gap-1.5">
        {slots.map((s) => (
          <FontCard key={s} slot={s} font={kit.fonts[s] as BrandFont} />
        ))}
      </div>
    </PanelSection>
  );
}

function BrandLogos({ kit }: { kit: BrandKitView }) {
  const editor = useEditor();
  const [busy, setBusy] = useState<string | null>(null);
  if (kit.logos.length === 0) return null;
  const place = async (logo: BrandLogo) => {
    const convex = editor.convex;
    if (!convex || !editor.canEdit) return;
    setBusy(logo.id);
    try {
      const view = await convex.query(refs.assetsGet, { assetId: logo.assetId });
      const ref = assetRefFromView(view);
      if (view.url) editor.assets.prime(ref.id, view.url);
      const size = fitToPage(view.width ?? 400, view.height ?? 200, editor.currentPage(), 0.35);
      const node =
        ref.kind === "svg"
          ? createSvg({ assetId: ref.id, name: logo.name, role: "logo", ...size })
          : createImage({ assetId: ref.id, name: logo.name, role: "logo", fit: "fit", ...size });
      await insertSubtree(editor, [node], { label: "Add logo", assets: [ref] });
    } catch (e) {
      editor.notify({
        kind: "error",
        title: "Couldn't place the logo",
        description: errorMessage(e),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <PanelSection title="Logos">
      <TileGrid min={88}>
        {kit.logos.map((logo) => (
          <Tile
            key={logo.id}
            label={`${logo.name} (${logo.variant})`}
            caption
            ratio={1.4}
            busy={busy === logo.id}
            disabled={!editor.canEdit || !logo.url}
            onClick={() => void place(logo)}
          >
            <span aria-hidden className="dsn-checker absolute inset-0 opacity-40" />
            {logo.url ? (
              <img
                src={logo.url}
                alt=""
                draggable={false}
                className="relative max-h-[70%] max-w-[78%] object-contain"
              />
            ) : (
              <ImageOff className="size-5 text-fg-muted" />
            )}
          </Tile>
        ))}
      </TileGrid>
    </PanelSection>
  );
}
