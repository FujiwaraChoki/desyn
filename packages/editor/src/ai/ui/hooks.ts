import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "../../context.tsx";
import type { EditorController } from "../../controller.ts";
import type { AiSession, AiSessionState } from "../session.ts";

/** One AI session per editor (created by the AI extension's setup). */
const sessions = new WeakMap<EditorController, AiSession>();

export function registerSession(editor: EditorController, session: AiSession): () => void {
  sessions.set(editor, session);
  return () => {
    if (sessions.get(editor) === session) sessions.delete(editor);
  };
}

export function sessionOf(editor: EditorController): AiSession | null {
  return sessions.get(editor) ?? null;
}

export function useAiSession(): AiSession {
  const session = sessionOf(useEditor());
  if (!session) throw new Error("The AI extension is not installed in this editor.");
  return session;
}

/** Subscribes to a slice of the AI session state (primitives or stable references). */
export function useAi<T>(selector: (s: AiSessionState) => T): T {
  return useStore(useAiSession().store, selector);
}

/** Same with shallow comparison for derived objects / arrays. */
export function useAiShallow<T>(selector: (s: AiSessionState) => T): T {
  return useStore(useAiSession().store, useShallow(selector));
}
