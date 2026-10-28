"use client";

import { type Platform, usePlatform } from "@desyn/ui";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { EditorController } from "./controller.ts";
import { formatCombo, keysFor } from "./shortcuts/keymap.ts";
import type { EditorState } from "./store/editor-store.ts";

/** React access to the editor instance. Every editor component lives under <EditorProvider>. */
const EditorContext = createContext<EditorController | null>(null);

export function EditorProvider({
  editor,
  children,
}: {
  editor: EditorController;
  children: ReactNode;
}) {
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>;
}

/** The editor controller (commands, apply, selection, engine...). */
export function useEditor(): EditorController {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error("useEditor must be used inside <EditorProvider>.");
  return editor;
}

/**
 * Subscribes to a slice of editor state. Return primitives or stable references (or wrap the selector in
 * zustand's `useShallow` for derived arrays / objects) so components re-render only when it changes.
 */
export function useEditorStore<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditor().store, selector);
}

/** Re-renders when commands or extension contributions are added / removed. */
export function useRegistryVersion(): number {
  const editor = useEditor();
  const commands = useSyncExternalStore(
    editor.commands.subscribe,
    editor.commands.getVersion,
    editor.commands.getVersion,
  );
  const extensions = useSyncExternalStore(
    editor.extensions.subscribe,
    editor.extensions.getVersion,
    editor.extensions.getVersion,
  );
  return commands * 100_000 + extensions;
}

export interface CommandState {
  id: string;
  exists: boolean;
  enabled: boolean;
  label: string;
  checked: boolean | undefined;
  /** First key binding (raw combo, e.g. `mod+d`), for tooltips and menus. */
  shortcut: string | undefined;
  run: (args?: unknown) => Promise<boolean>;
}

/** Live state of a command (enablement, label, check state, shortcut) for buttons and menus. */
export function useCommand(
  id: string,
  source: "button" | "menu" | "palette" = "button",
): CommandState {
  const editor = useEditor();
  useRegistryVersion();
  const snap = useStore(
    editor.store,
    useShallow((s: EditorState) => {
      const cmd = editor.commands.get(id);
      // context is cached per state object, so many buttons share one computation per change.
      const ctx = editor.contextFor(s);
      return {
        exists: !!cmd,
        enabled: !!cmd && editor.commands.isEnabled(id, ctx),
        label: editor.commands.label(id, ctx),
        checked: editor.commands.isChecked(id, ctx),
        shortcut: keysFor(id, s.keymap, cmd?.keys)[0],
      };
    }),
  );
  return { id, ...snap, run: (args?: unknown) => editor.commands.run(id, args, source) };
}

/** Formats a command's first binding for the user's OS (`⌘D`, `Ctrl+D`), or "". */
export function useShortcutLabel(id: string): string {
  const editor = useEditor();
  const keymap = useEditorStore((s) => s.keymap);
  const platform: Platform = usePlatform();
  const combo = keysFor(id, keymap, editor.commands.get(id)?.keys)[0];
  return combo ? formatCombo(combo, platform) : "";
}
