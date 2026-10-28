import {
  Brush,
  Copy,
  Eraser,
  Expand,
  FilePlus2,
  FileSpreadsheet,
  Languages,
  LayoutGrid,
  ListChecks,
  Megaphone,
  MessageSquareText,
  PenLine,
  PenTool,
  Square,
  Stamp,
  ZoomIn,
} from "lucide-react";
import type { AnyCommand } from "../commands/registry.ts";
import type { EditorController } from "../controller.ts";
import { defineExtension, type EditorExtension } from "../shell/extensions.ts";
import { createConvexAiBackend } from "./backend/convex.ts";
import type { AiBackend, WorkflowType } from "./backend/types.ts";
import { buildGoal } from "./core/prompt.ts";
import { isActive } from "./core/reduce.ts";
import { selectedImages } from "./media.ts";
import { AiSession } from "./session.ts";
import { AiRailPanel } from "./ui/ai-panel.tsx";
import { AiDock } from "./ui/dock.tsx";
import { AiGlow } from "./ui/glow.tsx";
import { registerSession, sessionOf } from "./ui/hooks.ts";
import { inpaintModal } from "./ui/inpaint-dialog.tsx";
import { AiInspectorTab } from "./ui/inspector-tab.tsx";
import { bulkModal } from "./ui/workflows/bulk.tsx";
import { campaignModal } from "./ui/workflows/campaign.tsx";
import { localizeModal } from "./ui/workflows/localize.tsx";
import { resizeModal } from "./ui/workflows/resize.tsx";
import { variantsModal } from "./ui/workflows/variants.tsx";

/**
 * The AI feature of the editor (SPEC §7, DESIGN_SYSTEM §6): the AI dock (prompt bar + conversation and run
 * log), the canvas glow, the "AI" rail panel (generator, workflows, history), the "AI" inspector tab (image
 * and text actions), workflow dialogs, commands and the "Edit with AI…" context menu entry.
 */

export interface AiExtensionOptions {
  /** Backend override (tests, playground). Default: the Convex AI backend on `editor.convex`. */
  backend?: AiBackend | null;
}

function focusDock(editor: EditorController): void {
  const dock = editor.getState().panels.aiDock;
  editor.setPanels({ aiDock: dock === "closed" ? "bar" : dock, focusMode: false });
  window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
}

const WORKFLOW_COMMANDS: {
  type: WorkflowType;
  label: string;
  icon: AnyCommand["icon"];
  keywords: string[];
}[] = [
  {
    type: "campaign",
    label: "Create a campaign…",
    icon: Megaphone,
    keywords: ["brief", "set", "launch"],
  },
  {
    type: "variants",
    label: "Create variants…",
    icon: Copy,
    keywords: ["a/b", "alternatives", "test"],
  },
  {
    type: "resize",
    label: "Magic resize…",
    icon: LayoutGrid,
    keywords: ["sizes", "formats", "reflow"],
  },
  {
    type: "localize",
    label: "Localize…",
    icon: Languages,
    keywords: ["translate", "languages", "rtl"],
  },
  {
    type: "bulk",
    label: "Bulk create from CSV…",
    icon: FileSpreadsheet,
    keywords: ["csv", "spreadsheet", "merge"],
  },
];

function aiCommands(): AnyCommand[] {
  const session = (editor: EditorController) => sessionOf(editor);
  return [
    {
      id: "ai.editSelection",
      label: "Edit with AI…",
      category: "ai",
      icon: PenLine,
      keywords: ["ask", "change", "prompt"],
      when: "canEdit && hasSelection",
      run: (_a, { editor }) => {
        session(editor)?.setMode("edit-selection");
        focusDock(editor);
      },
    },
    {
      id: "ai.generateDesign",
      label: "Generate a design with AI…",
      category: "ai",
      icon: FilePlus2,
      keywords: ["create", "new", "prompt", "build"],
      when: "canEdit",
      run: (_a, { editor }) => {
        session(editor)?.setMode("generate");
        focusDock(editor);
      },
    },
    {
      id: "ai.critique",
      label: "Critique this design",
      category: "ai",
      icon: ListChecks,
      keywords: ["review", "feedback", "improve"],
      when: "loaded && signedIn",
      run: (_a, { editor }) => {
        const s = session(editor);
        if (!s?.check("agent.critique")) return;
        const prompt = "Critique this design: hierarchy, spacing, typography, color and contrast.";
        void s.runAgent({
          title: "Critique this design",
          goal: buildGoal({ mode: "critique", prompt, brand: null, attachments: [] }),
          mode: "critique",
          selection: [],
          command: null,
        });
      },
    },
    {
      id: "ai.removeBackground",
      label: "Remove background",
      category: "ai",
      icon: Eraser,
      keywords: ["cut out", "matte", "transparent"],
      when: "canEdit && selectionHasImage",
      run: (_a, { editor }) => void session(editor)?.removeBackground(),
    },
    {
      id: "ai.upscale",
      label: "Upscale image 2×",
      category: "ai",
      icon: ZoomIn,
      keywords: ["sharpen", "resolution", "enhance"],
      when: "canEdit && selectionHasImage",
      run: (_a, { editor }) => void session(editor)?.upscale(2),
    },
    {
      id: "ai.expand",
      label: "Expand image…",
      category: "ai",
      icon: Expand,
      keywords: ["outpaint", "extend", "uncrop"],
      when: "canEdit && selectionHasImage",
      run: (_a, { editor }) => session(editor)?.openInspectorActions("expand"),
    },
    {
      id: "ai.inpaint",
      label: "Repaint an area…",
      category: "ai",
      icon: Brush,
      keywords: ["inpaint", "erase", "replace object"],
      when: "canEdit && selectionHasImage",
      run: (_a, { editor }) => {
        const s = session(editor);
        const target = selectedImages(editor)[0];
        if (s?.check("inpaint") && target)
          editor.openModal("ai.inpaint", { nodeId: target.node.id });
      },
    },
    {
      id: "ai.trace",
      label: "Trace image to vector",
      category: "ai",
      icon: PenTool,
      keywords: ["vectorize", "svg"],
      when: "canEdit && selectionHasImage",
      run: (_a, { editor }) => void session(editor)?.trace(),
    },
    {
      id: "ai.matchBrand",
      label: "Match my brand",
      category: "ai",
      icon: Stamp,
      keywords: ["brand kit", "restyle", "colors", "fonts"],
      when: "canEdit",
      run: (_a, { editor }) => void session(editor)?.matchBrand(),
    },
    ...WORKFLOW_COMMANDS.map(
      (w): AnyCommand => ({
        id: `ai.workflow.${w.type}`,
        label: w.label,
        category: "ai",
        icon: w.icon,
        keywords: w.keywords,
        when: "loaded && signedIn",
        run: (_a, { editor }) => session(editor)?.openWorkflow(w.type, {}),
      }),
    ),
    {
      id: "ai.stop",
      label: "Stop the AI",
      category: "ai",
      icon: Square,
      keys: ["mod+."],
      allowInInput: true,
      when: (_c, editor) =>
        !!session(editor)?.state.turns.some(
          (t) => (t.run && isActive(t.run)) || t.media?.status === "running",
        ),
      run: (_a, { editor }) => void session(editor)?.stopAll(),
    },
  ];
}

export function createAiExtension(options: AiExtensionOptions = {}): EditorExtension {
  return defineExtension({
    id: "ai",
    setup(api) {
      const editor = api.editor;
      const backend =
        options.backend !== undefined
          ? options.backend
          : editor.convex
            ? createConvexAiBackend(editor.convex)
            : null;
      const session = new AiSession(editor, backend);
      const unregister = registerSession(editor, session);
      session.start();
      api.onDispose(() => {
        session.dispose();
        unregister();
      });
      api.registerSlot("ai.dock", { id: "ai-dock", component: AiDock });
      api.registerSlot("canvas.overlay", { id: "ai-glow", component: AiGlow, order: 40 });
      api.registerRailPanel({
        id: "ai",
        label: "AI",
        icon: MessageSquareText,
        order: 70,
        component: AiRailPanel,
        modes: ["edit"],
      });
      api.registerInspectorTab({
        id: "ai",
        label: "AI",
        order: 60,
        component: AiInspectorTab,
        modes: ["edit"],
        when: (ctx) => ctx.hasSelection === true,
      });
      for (const modal of [
        inpaintModal,
        campaignModal,
        variantsModal,
        resizeModal,
        localizeModal,
        bulkModal,
      ]) {
        api.registerModal(modal);
      }
      api.registerCommands(aiCommands());
      api.registerContextMenu([
        { command: "ai.editSelection", target: "selection", order: 5 },
        { command: "ai.removeBackground", target: "selection", order: 6 },
        { command: "-", target: "selection", order: 7 },
        { command: "ai.generateDesign", target: "canvas", order: 5 },
        { command: "-", target: "canvas", order: 7 },
      ]);
    },
  });
}

/** The AI extension on the app's Convex client (BUILTIN_EXTENSIONS). */
export const aiExtension = createAiExtension();

export { createConvexAiBackend } from "./backend/convex.ts";
export type { AiBackend } from "./backend/types.ts";
export { AiSession } from "./session.ts";
