import type { Design } from "@desyn/schema";
import { Presentation } from "lucide-react";
import { createElement, useSyncExternalStore } from "react";
import type { AnyCommand } from "../commands/registry.ts";
import type { EditorController } from "../controller.ts";
import { defineExtension, type EditorExtension, type SlotProps } from "../shell/extensions.ts";
import { Presenter } from "./presenter.tsx";
import { presentationSlides } from "./timeline.ts";

interface Presenting {
  design: Design;
  startIndex: number;
  presenterView: boolean;
}

/** Per-editor presentation state (the overlay subscribes; commands start it). */
class PresentState {
  value: Presenting | null = null;
  private listeners = new Set<() => void>();
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.value;
  set(v: Presenting | null) {
    this.value = v;
    for (const l of this.listeners) l();
  }
}

const states = new WeakMap<EditorController, PresentState>();
const stateOf = (editor: EditorController) => {
  let s = states.get(editor);
  if (!s) {
    s = new PresentState();
    states.set(editor, s);
  }
  return s;
};

/** Starts presenting the open design in place (full screen over the editor). */
export function startPresenting(
  editor: EditorController,
  options: { fromStart?: boolean; presenterView?: boolean } = {},
): void {
  const design = editor.design;
  if (!design) return;
  const slides = presentationSlides(design);
  if (slides.length === 0) {
    editor.notify({
      kind: "info",
      title: "Nothing to present",
      description: "Every page is hidden.",
    });
    return;
  }
  const current = editor.getState().pageId;
  const index = options.fromStart
    ? 0
    : Math.max(
        0,
        slides.findIndex((s) => s.pageId === current),
      );
  // Full screen needs the user's gesture, so it is requested here, not when the overlay mounts.
  void document.documentElement.requestFullscreen?.().catch(() => {});
  stateOf(editor).set({ design, startIndex: index, presenterView: options.presenterView ?? false });
  editor.telemetry("present_started", {
    slides: slides.length,
    presenterView: !!options.presenterView,
  });
}

function PresentOverlay({ editor }: SlotProps) {
  const state = stateOf(editor);
  const presenting = useSyncExternalStore(state.subscribe, state.get, state.get);
  if (!presenting) return null;
  return createElement(Presenter, {
    design: presenting.design,
    startIndex: presenting.startIndex,
    presenterView: presenting.presenterView,
    resolveAsset: (asset) => editor.assets.urlFor(asset),
    onSlideChange: (i: number) => {
      // Follow along in the editor, so leaving the presentation lands on the last shown page.
      const id = presentationSlides(presenting.design)[i]?.pageId;
      if (id && id !== editor.getState().pageId && editor.design?.nodes[id]?.type === "page") {
        editor.setPage(id);
      }
    },
    onExit: () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      state.set(null);
    },
  });
}

function presentCommands(): AnyCommand[] {
  return [
    {
      id: "present.start",
      label: "Present",
      category: "file",
      icon: Presentation,
      keywords: ["slideshow", "presentation", "fullscreen", "play"],
      keys: ["mod+alt+enter"],
      when: "loaded",
      run: (_a, { editor }) => startPresenting(editor),
    },
    {
      id: "present.fromStart",
      label: "Present from the first page",
      category: "file",
      icon: Presentation,
      keywords: ["slideshow", "presentation"],
      when: "loaded",
      run: (_a, { editor }) => startPresenting(editor, { fromStart: true }),
    },
    {
      id: "present.presenterView",
      label: "Present with speaker notes",
      category: "file",
      icon: Presentation,
      keywords: ["presenter view", "notes", "timer", "slideshow"],
      when: "loaded",
      run: (_a, { editor }) => startPresenting(editor, { presenterView: true }),
    },
  ];
}

/** Present mode inside the editor (and the `Presenter` / `PresentDesign` components for apps/web). */
export function createPresentExtension(): EditorExtension {
  return defineExtension({
    id: "present",
    setup(api) {
      api.registerSlot("root", { id: "present.overlay", component: PresentOverlay });
      api.registerCommands(presentCommands());
      api.onDispose(() => states.delete(api.editor));
    },
  });
}

export const presentExtension = createPresentExtension();

export { PresentDesign, type PresentDesignProps } from "./present-design.tsx";
export { Presenter, type PresenterProps } from "./presenter.tsx";
export { presentationSlides, type SlideTiming } from "./timeline.ts";
