import {
  Command as CommandIcon,
  Download,
  GalleryHorizontalEnd,
  History,
  Keyboard,
  Layers,
  Link,
  LogOut,
  MessageSquareText,
  MessagesSquare,
  PanelRight,
  Play,
  Save,
  Shapes,
  Share2,
  Stamp,
  TextCursorInput,
} from "lucide-react";
import type { EditorController } from "../controller.ts";
import type { AnyCommand } from "./registry.ts";

/** Opens a left rail panel when an extension registered it. */
function railCommand(
  id: string,
  panel: string,
  label: string,
  icon: AnyCommand["icon"],
): AnyCommand {
  return {
    id,
    label,
    category: "panel",
    ...(icon ? { icon } : {}),
    when: (_ctx, editor) => editor.extensions.railPanels.some((p) => p.id === panel),
    checked: (ctx) => ctx.leftPanel === panel,
    run: (_a, { editor }) => editor.toggleLeftPanel(panel),
  };
}

const hasModal = (id: string) => (_ctx: unknown, editor: EditorController) =>
  editor.extensions.modals.has(id);

/** Downloads bytes as a file (quick exports without the export dialog). */
function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 120) || "design"
  );
}

export function panelCommands(): AnyCommand[] {
  return [
    railCommand("panel.layers", "layers", "Layers", Layers),
    railCommand("panel.elements", "elements", "Elements", Shapes),
    railCommand("panel.brand", "brand", "Brand", Stamp),
    railCommand("panel.pagesList", "pages", "Pages panel", GalleryHorizontalEnd),
    railCommand("panel.comments", "comments", "Comments", MessagesSquare),
    {
      id: "panel.open",
      label: "Open panel",
      category: "panel",
      hidden: true,
      run: (args: { id: string }, { editor }) => editor.toggleLeftPanel(args.id, true),
    },
    {
      id: "panel.toggleInspector",
      label: "Inspector",
      category: "panel",
      icon: PanelRight,
      when: (_c, editor) => editor.extensions.inspectorTabs.length > 0,
      checked: (ctx) => ctx.inspectorOpen === true,
      run: (_a, { editor }) =>
        editor.setPanels({ inspectorOpen: !editor.getState().panels.inspectorOpen }),
    },
    {
      id: "panel.togglePages",
      label: "Pages strip",
      category: "panel",
      icon: GalleryHorizontalEnd,
      when: (_c, editor) => !!editor.extensions.slot("pages"),
      checked: (ctx) => ctx.pagesOpen === true,
      run: (_a, { editor }) => editor.setPanels({ pagesOpen: !editor.getState().panels.pagesOpen }),
    },
    {
      id: "panel.toggleAiDock",
      label: "Ask AI",
      category: "ai",
      icon: MessageSquareText,
      keywords: ["assistant", "generate", "agent", "prompt"],
      allowInInput: true,
      when: (_c, editor) => !!editor.extensions.slot("ai.dock"),
      run: (_a, { editor }) => {
        const dock = editor.getState().panels.aiDock;
        editor.setPanels({ aiDock: dock === "closed" ? "bar" : dock, focusMode: false });
        // The dock focuses its prompt on this event (also when it was already open).
        window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
      },
    },
    {
      id: "panel.versions",
      label: "Version history",
      category: "file",
      icon: History,
      when: hasModal("versions"),
      run: (_a, { editor }) => editor.openModal("versions"),
    },
    {
      id: "file.saveVersion",
      label: "Save a named version",
      category: "file",
      icon: Save,
      when: (ctx, editor) => ctx.canEdit === true && editor.extensions.modals.has("save-version"),
      run: (_a, { editor }) => editor.openModal("save-version"),
    },
    {
      id: "file.export",
      label: "Export…",
      category: "file",
      icon: Download,
      keywords: ["download", "png", "pdf", "svg", "jpg"],
      when: (ctx, editor) => ctx.loaded === true && editor.extensions.modals.has("export"),
      run: (_a, { editor }) => editor.openModal("export"),
    },
    {
      id: "file.downloadPng",
      label: "Download this page as PNG",
      category: "file",
      icon: Download,
      when: "engineReady",
      run: async (_a, { editor }) => {
        const page = editor.currentPage();
        if (!page) return;
        try {
          const { bytes } = await editor.engine.export({
            format: "png",
            pageId: page.id,
            scale: 2,
          });
          download(
            bytes,
            `${safeFileName(editor.design?.name ?? "design")} - ${safeFileName(page.name)}.png`,
            "image/png",
          );
        } catch (e) {
          editor.notify({
            kind: "error",
            title: "Couldn't export the page",
            description: e instanceof Error ? e.message : String(e),
          });
        }
      },
    },
    {
      id: "file.share",
      label: "Share…",
      category: "file",
      icon: Share2,
      when: hasModal("share"),
      run: (_a, { editor }) => editor.openModal("share"),
    },
    {
      id: "file.copyLink",
      label: "Copy link to design",
      category: "file",
      icon: Link,
      when: "loaded",
      run: async (_a, { editor }) => {
        const { designId, shareToken } = editor.getState();
        const url = `${window.location.origin}/design/${encodeURIComponent(designId)}${
          shareToken ? `?share=${encodeURIComponent(shareToken)}` : ""
        }`;
        try {
          await navigator.clipboard.writeText(url);
          editor.notify({ kind: "success", title: "Link copied" });
        } catch {
          editor.notify({ kind: "error", title: "Couldn't copy the link", description: url });
        }
      },
    },
    {
      id: "file.present",
      label: "Present from this page",
      category: "file",
      icon: Play,
      keywords: ["slideshow", "presentation"],
      when: "loaded",
      run: (_a, { editor }) => {
        const s = editor.getState();
        const ids = editor.design
          ? ((editor.design.nodes.root as { children?: string[] }).children ?? [])
          : [];
        const slide = Math.max(1, ids.indexOf(s.pageId ?? "") + 1);
        const share = s.shareToken ? `&share=${encodeURIComponent(s.shareToken)}` : "";
        editor.navigate(`/present/${encodeURIComponent(s.designId)}?slide=${slide}${share}`);
      },
    },
    {
      id: "file.rename",
      label: "Rename design",
      category: "file",
      icon: TextCursorInput,
      when: "canEdit",
      run: () => {
        window.dispatchEvent(new CustomEvent("desyn:rename-design"));
      },
    },
    {
      id: "file.exit",
      label: "Back to designs",
      category: "file",
      icon: LogOut,
      run: (_a, { editor }) => editor.navigate(editor.getState().exitHref),
    },
    {
      id: "help.commandPalette",
      label: "Command palette",
      category: "help",
      icon: CommandIcon,
      allowInInput: true,
      hidden: true,
      run: (_a, { editor }) =>
        editor.store.setState((s) => ({ paletteOpen: !s.paletteOpen, modal: null })),
    },
    {
      id: "help.shortcuts",
      label: "Keyboard shortcuts",
      category: "help",
      icon: Keyboard,
      allowInInput: true,
      run: (_a, { editor }) => editor.openModal("shortcuts"),
    },
  ];
}
