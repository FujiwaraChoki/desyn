import { pages as listPages, movePage } from "@desyn/doc-ops";
import type { Id } from "@desyn/schema";
import {
  Camera,
  CloudUpload,
  GalleryHorizontalEnd,
  Heading1,
  Heading2,
  Layers,
  LayoutTemplate,
  Pilcrow,
  Scaling,
  Shapes,
  Sheet,
  Stamp,
  Type,
} from "lucide-react";
import type { AnyCommand, CommandIcon } from "../commands/registry.ts";
import { defineExtension } from "../shell/extensions.ts";
import { ChartDataDialog } from "./dialogs/chart-data-dialog.tsx";
import { ResizePageDialog } from "./dialogs/resize-page-dialog.tsx";
import { AnimateTab } from "./inspector/animate-tab.tsx";
import { ArrangeTab } from "./inspector/arrange-tab.tsx";
import { DesignTab } from "./inspector/design-tab.tsx";
import { EffectsTab } from "./inspector/effects-tab.tsx";
import { LayersPanel } from "./layers/layers-panel.tsx";
import { TEXT_PRESETS, textFromPreset } from "./lib/catalog.ts";
import { insertSubtree } from "./lib/insert.ts";
import { pageInk } from "./lib/page-color.ts";
import { thumbnailCache } from "./lib/thumbnails.ts";
import { PagesPanel } from "./pages/pages-panel.tsx";
import { PagesStrip } from "./pages/pages-strip.tsx";
import { BrandPanel } from "./rail/brand-panel.tsx";
import { DesignPanel } from "./rail/design-panel.tsx";
import { ElementsPanel } from "./rail/elements-panel.tsx";
import { PhotosPanel } from "./rail/photos-panel.tsx";
import { TextPanel } from "./rail/text-panel.tsx";
import { UploadsPanel } from "./rail/uploads-panel.tsx";

/**
 * Panels extension: the left rail flyouts (Design / templates, Elements, Text, Brand, Uploads, Photos,
 * Layers, Pages), the inspector tabs (Design, Effects, Arrange, Animate), the pages strip, the page resize
 * and chart data dialogs, and the commands / context menu entries that open them. The top bar, command
 * palette and shortcuts dialog are the shell's; the panels' commands appear in them automatically.
 */

function railCommand(
  id: string,
  panel: string,
  label: string,
  icon: CommandIcon,
  keywords: string[],
): AnyCommand {
  return {
    id,
    label,
    category: "panel",
    icon,
    keywords,
    when: (_ctx, editor) => editor.extensions.railPanels.some((p) => p.id === panel),
    checked: (ctx) => ctx.leftPanel === panel,
    run: (_a, { editor }) => editor.toggleLeftPanel(panel),
  };
}

function textCommand(
  id: (typeof TEXT_PRESETS)[number]["id"],
  label: string,
  icon: CommandIcon,
): AnyCommand {
  return {
    id: `insert.${id}`,
    label,
    category: "text",
    icon,
    keywords: ["text", "type", "add"],
    when: "canEdit && !textEditing",
    run: (_a, { editor }) => {
      const preset = TEXT_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      return insertSubtree(editor, [textFromPreset(preset, undefined, pageInk(editor))], {
        label: `Add ${id}`,
      });
    },
  };
}

function panelCommands(): AnyCommand[] {
  return [
    railCommand("panel.design", "design", "Templates", LayoutTemplate, [
      "design",
      "template",
      "layout",
    ]),
    railCommand("panel.text", "text", "Text panel", Type, ["fonts", "font pairing", "typography"]),
    railCommand("panel.uploads", "uploads", "Uploads", CloudUpload, [
      "library",
      "files",
      "images",
      "assets",
    ]),
    railCommand("panel.photos", "photos", "Stock photos", Camera, [
      "unsplash",
      "pexels",
      "pictures",
    ]),
    textCommand("heading", "Add heading", Heading1),
    textCommand("subheading", "Add subheading", Heading2),
    textCommand("body", "Add body text", Pilcrow),
    {
      id: "page.resize",
      label: "Resize page…",
      category: "page",
      icon: Scaling,
      keywords: ["size", "format", "dimensions", "magic resize"],
      when: "canEdit && pageCount > 0",
      run: (args: { pageId?: Id } | undefined, { editor }) => {
        const pageId = args?.pageId ?? editor.getState().pageId;
        if (pageId) editor.openModal("page-resize", { pageId });
      },
    },
    {
      id: "page.moveTo",
      label: "Move page",
      category: "page",
      hidden: true,
      when: "canEdit && multiplePages",
      run: (args: { pageId: Id; targetId: Id; side: "before" | "after" }, { editor }) =>
        editor.apply((design) => {
          const ids = listPages(design).map((p) => p.id);
          const from = ids.indexOf(args.pageId);
          const rest = ids.filter((id) => id !== args.pageId);
          const at = rest.indexOf(args.targetId);
          if (from < 0 || at < 0) return null;
          const index = args.side === "before" ? at : at + 1;
          return index === from ? null : movePage(design, args.pageId, index);
        }),
    },
    {
      id: "edit.chartData",
      label: "Edit chart data…",
      category: "edit",
      icon: Sheet,
      keywords: ["chart", "data", "values", "spreadsheet"],
      when: "canEdit && singleSelection && selectionType == 'chart'",
      run: (_a, { editor }) => {
        const id = editor.getState().selection[0];
        if (id) editor.openModal("chart-data", { nodeId: id });
      },
    },
  ];
}

export const panelsExtension = defineExtension({
  id: "panels",
  setup(api) {
    const editOnly = { modes: ["edit" as const] };
    api.registerRailPanel({
      id: "design",
      label: "Design",
      icon: LayoutTemplate,
      order: 10,
      component: DesignPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "elements",
      label: "Elements",
      icon: Shapes,
      order: 20,
      component: ElementsPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "text",
      label: "Text",
      icon: Type,
      order: 30,
      component: TextPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "brand",
      label: "Brand",
      icon: Stamp,
      order: 40,
      component: BrandPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "uploads",
      label: "Uploads",
      icon: CloudUpload,
      order: 50,
      component: UploadsPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "photos",
      label: "Photos",
      icon: Camera,
      order: 60,
      component: PhotosPanel,
      ...editOnly,
    });
    api.registerRailPanel({
      id: "layers",
      label: "Layers",
      icon: Layers,
      order: 80,
      component: LayersPanel,
    });
    api.registerRailPanel({
      id: "pages",
      label: "Pages",
      icon: GalleryHorizontalEnd,
      order: 90,
      component: PagesPanel,
    });

    api.registerInspectorTab({
      id: "design",
      label: "Design",
      order: 10,
      component: DesignTab,
      ...editOnly,
    });
    api.registerInspectorTab({
      id: "effects",
      label: "Effects",
      order: 20,
      component: EffectsTab,
      ...editOnly,
      when: (ctx) => ctx.selectionHasNodes === true,
    });
    api.registerInspectorTab({
      id: "arrange",
      label: "Arrange",
      order: 30,
      component: ArrangeTab,
      ...editOnly,
      when: (ctx) => ctx.selectionHasNodes === true,
    });
    api.registerInspectorTab({
      id: "animate",
      label: "Animate",
      order: 40,
      component: AnimateTab,
      ...editOnly,
    });

    api.registerSlot("pages", { id: "pages-strip", component: PagesStrip });
    api.registerModal({ id: "page-resize", component: ResizePageDialog });
    api.registerModal({ id: "chart-data", component: ChartDataDialog });
    api.registerCommands(panelCommands());
    api.registerContextMenu([
      { command: "edit.chartData", target: "selection", order: 6 },
      { command: "page.resize", target: "canvas", order: 43 },
    ]);
    api.onDispose(() => thumbnailCache(api.editor).dispose());
  },
});
