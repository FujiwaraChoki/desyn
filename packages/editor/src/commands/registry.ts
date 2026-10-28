import type { ComponentType, SVGProps } from "react";
import type { EditorController } from "../controller.ts";
import { evaluateWhen, validateWhen, type WhenContext } from "./when.ts";

/**
 * Command registry: every editor action is a command with an id, a label, a when-clause and `run`.
 * Menus, the command palette, context menus, toolbar buttons and keyboard shortcuts all go through it, so
 * an action behaves the same everywhere and its enablement is computed in one place.
 *
 * Default key bindings live in `shortcuts/defaults.ts` (one table mirrored by the docs and settings pages);
 * a command registered by an extension can bring its own `keys`.
 */

export type CommandCategory =
  | "edit"
  | "selection"
  | "clipboard"
  | "arrange"
  | "view"
  | "page"
  | "tool"
  | "panel"
  | "file"
  | "history"
  | "text"
  | "ai"
  | "collab"
  | "help";

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  edit: "Edit",
  selection: "Selection",
  clipboard: "Clipboard",
  arrange: "Arrange",
  view: "View",
  page: "Pages",
  tool: "Tools",
  panel: "Panels",
  file: "File",
  history: "History",
  text: "Text",
  ai: "AI",
  collab: "Collaboration",
  help: "Help",
};

export type CommandIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface CommandRunContext {
  editor: EditorController;
  /** How it was triggered (shortcuts may behave differently, e.g. paste via keyboard uses the event). */
  source: "keyboard" | "palette" | "menu" | "button" | "api";
  /** The keyboard event for keyboard triggers. */
  event?: KeyboardEvent;
}

export interface Command<Args = void> {
  /** Stable id, `category.name` (e.g. `edit.duplicate`). Referenced by keymaps and slots. */
  id: string;
  label: string | ((ctx: WhenContext) => string);
  category: CommandCategory;
  /** Enablement: a when-clause over `commandContext` keys, or a predicate. Default: always. */
  when?: string | ((ctx: WhenContext, editor: EditorController) => boolean);
  run: (args: Args, run: CommandRunContext) => unknown;
  icon?: CommandIcon;
  /** Extra search words for the palette. */
  keywords?: string[];
  /** Default key bindings when `shortcuts/defaults.ts` has none for this id. */
  keys?: string[];
  /** Hidden from the command palette (still runnable and bindable). */
  hidden?: boolean;
  /** Toggle state for menus / palette checkmarks. */
  checked?: (ctx: WhenContext, editor: EditorController) => boolean;
  /** Fire on key auto-repeat (nudges, zoom). */
  repeat?: boolean;
  /** Also fire while focus is in a text field (default false). */
  allowInInput?: boolean;
  /** Keep the browser's default action for the key (e.g. native copy events). */
  passThrough?: boolean;
}

// Commands with arguments are stored type-erased; `run(id, args)` passes whatever the caller gives.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry of commands with different argument types
export type AnyCommand = Command<any>;

export class CommandRegistry {
  private readonly commands = new Map<string, AnyCommand>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly editor: () => EditorController) {}

  /** Registers commands; returns a function that unregisters them. Ids must be unique. */
  register(commands: AnyCommand | AnyCommand[]): () => void {
    const list = Array.isArray(commands) ? commands : [commands];
    for (const c of list) {
      if (this.commands.has(c.id)) throw new Error(`Command "${c.id}" is already registered.`);
      if (typeof c.when === "string") validateWhen(c.when);
    }
    for (const c of list) this.commands.set(c.id, c);
    this.bump();
    return () => {
      for (const c of list) if (this.commands.get(c.id) === c) this.commands.delete(c.id);
      this.bump();
    };
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** For `useSyncExternalStore`: changes whenever commands are added or removed. */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(id: string): AnyCommand | undefined {
    return this.commands.get(id);
  }

  all(): AnyCommand[] {
    return [...this.commands.values()];
  }

  label(id: string, ctx?: WhenContext): string {
    const c = this.commands.get(id);
    if (!c) return id;
    return typeof c.label === "function" ? c.label(ctx ?? this.editor().context()) : c.label;
  }

  isEnabled(id: string, ctx?: WhenContext): boolean {
    const c = this.commands.get(id);
    if (!c) return false;
    if (!c.when) return true;
    const context = ctx ?? this.editor().context();
    return typeof c.when === "string"
      ? evaluateWhen(c.when, context)
      : c.when(context, this.editor());
  }

  isChecked(id: string, ctx?: WhenContext): boolean | undefined {
    const c = this.commands.get(id);
    if (!c?.checked) return undefined;
    return c.checked(ctx ?? this.editor().context(), this.editor());
  }

  /**
   * Runs a command when it exists and is enabled. Resolves to whether it ran. A failing command never
   * rejects (keyboard, menus and buttons fire and forget): the user gets an error toast and the failure is
   * reported as `command_failed` telemetry.
   */
  async run(
    id: string,
    args?: unknown,
    source: CommandRunContext["source"] = "api",
    event?: KeyboardEvent,
  ): Promise<boolean> {
    const c = this.commands.get(id);
    if (!c || !this.isEnabled(id)) return false;
    const editor = this.editor();
    try {
      await c.run(args, { editor, source, ...(event ? { event } : {}) });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      editor.notify({ kind: "error", title: `${this.label(id)} failed`, description: message });
      // No message in telemetry: it can quote design content.
      editor.telemetry("command_failed", {
        command: id,
        source,
        error: e instanceof Error ? e.name : typeof e,
      });
      return false;
    }
  }
}
