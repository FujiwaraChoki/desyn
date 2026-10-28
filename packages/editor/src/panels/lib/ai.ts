import { sessionOf } from "../../ai/ui/hooks.ts";
import type { EditorController } from "../../controller.ts";

/**
 * Hand-off from panel buttons ("Generate an illustration", "Match with AI"...) to the AI dock (the `ai.dock`
 * slot, owned by the AI extension in src/ai). With the AI session present the prompt goes straight into it
 * (`setText`, mode, `submit` when `autoStart`); otherwise it is left in `state.ai.initialPrompt` and announced
 * with `desyn:ai-prompt` `{ prompt, autoStart, selection }` for any other dock implementation. The dock is
 * opened and focused (`desyn:ai-focus`) either way.
 */

export interface AiPromptDetail {
  prompt: string;
  autoStart: boolean;
  /** Layer ids the request is about (the dock attaches them as the run's selection). */
  selection: string[];
}

export const AI_PROMPT_EVENT = "desyn:ai-prompt";

/** True when an AI dock is registered (otherwise AI buttons are hidden). */
export function hasAiDock(editor: EditorController): boolean {
  return !!editor.extensions.slot("ai.dock");
}

export function askAi(
  editor: EditorController,
  prompt: string,
  options: { autoStart?: boolean; scope?: "auto" | "design" } = {},
): boolean {
  if (!hasAiDock(editor)) {
    editor.notify({
      kind: "info",
      title: "The AI assistant isn't available here",
      description: "Open the design in the Desyn app to use AI tools.",
    });
    return false;
  }
  const autoStart = options.autoStart ?? false;
  const selection = [...editor.getState().selection];
  editor.setPanels({ aiDock: "expanded", focusMode: false });
  const session = sessionOf(editor);
  if (session) {
    session.setText(prompt);
    session.setMode(
      options.scope === "design" || selection.length === 0 ? "edit-design" : "edit-selection",
    );
    if (autoStart) void session.submit();
  } else {
    editor.store.setState((s) => ({
      ai: { ...s.ai, initialPrompt: prompt, autoStart, runId: null },
    }));
    const detail: AiPromptDetail = { prompt, autoStart, selection };
    window.dispatchEvent(new CustomEvent(AI_PROMPT_EVENT, { detail }));
  }
  window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
  editor.telemetry("panel_ai_handoff", { autoStart });
  return true;
}
