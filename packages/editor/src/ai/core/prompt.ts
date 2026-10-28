import type { AgentMode, OutpaintDirection } from "@desyn/ai";
import { type CreditAction, creditCost } from "@desyn/schema";
import type { AiAction } from "./gating.ts";

/**
 * Prompt-bar state: the dock mode, slash commands and their arguments, and how a prompt becomes an agent goal.
 * Everything here is pure so the dock, tests and the session share one interpretation of what the user typed.
 */

export type DockMode = "edit-selection" | "edit-design" | "generate" | "critique";

export interface ModeInfo {
  id: DockMode;
  label: string;
  hint: string;
  placeholder: string;
  agent: AgentMode;
  action: AiAction;
}

export const MODES: readonly ModeInfo[] = [
  {
    id: "edit-selection",
    label: "Edit selection",
    hint: "Changes only the selected layers",
    placeholder: "Make the headline warmer and tighter…",
    agent: "edit",
    action: "agent.edit",
  },
  {
    id: "edit-design",
    label: "Edit design",
    hint: "Works across the whole page",
    placeholder: "Make this feel more premium…",
    agent: "edit",
    action: "agent.edit",
  },
  {
    id: "generate",
    label: "Generate new design",
    hint: "Builds a complete design from a brief",
    placeholder: "A poster for a midnight jazz night in Lisbon…",
    agent: "generate",
    action: "agent.generate",
  },
  {
    id: "critique",
    label: "Critique",
    hint: "Reviews the design without changing it",
    placeholder: "What would make this stronger?",
    agent: "critique",
    action: "agent.critique",
  },
];

export function modeInfo(mode: DockMode): ModeInfo {
  return MODES.find((m) => m.id === mode) as ModeInfo;
}

/** Mode the dock starts in: edit the selection when there is one, else the design. */
export function defaultMode(selectionCount: number): DockMode {
  return selectionCount > 0 ? "edit-selection" : "edit-design";
}

export type SlashId =
  | "image"
  | "svg"
  | "remove-bg"
  | "expand"
  | "upscale"
  | "mockup"
  | "translate"
  | "resize"
  | "variants"
  | "campaign"
  | "brand";

export interface SlashCommand {
  id: SlashId;
  label: string;
  description: string;
  /** Argument hint shown after the command. */
  args: string;
  action: AiAction;
  /** Needs a selected image (or another selection kind) to run. */
  needs?: "image" | "selection";
  /** Credit action billed per use (estimates); workflows and agent runs estimate separately. */
  credits?: CreditAction;
  /** Opens a dialog instead of running inline when there are no arguments. */
  dialog?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "image",
    label: "Image",
    description: "Generate an image and place it",
    args: "a sunlit ceramic vase on linen",
    action: "image",
    credits: "ai.image",
  },
  {
    id: "svg",
    label: "Vector",
    description: "Draw an editable vector illustration or icon",
    args: "a minimal line-art sun",
    action: "svg",
    credits: "ai.svg",
  },
  {
    id: "remove-bg",
    label: "Remove background",
    description: "Cut the subject out of the selected image",
    args: "",
    action: "removeBackground",
    needs: "image",
    credits: "ai.removeBackground",
  },
  {
    id: "expand",
    label: "Expand",
    description: "Extend the selected image beyond its edges",
    args: "16:9 left",
    action: "outpaint",
    needs: "image",
    credits: "ai.outpaint",
    dialog: true,
  },
  {
    id: "upscale",
    label: "Upscale",
    description: "Sharpen the selected image at 2× or 4×",
    args: "2x",
    action: "upscale",
    needs: "image",
    credits: "ai.upscale",
  },
  {
    id: "mockup",
    label: "Mockup",
    description: "Stage this page in a photographed scene",
    args: "framed on a gallery wall",
    action: "mockup",
    credits: "ai.mockup",
    dialog: true,
  },
  {
    id: "translate",
    label: "Translate",
    description: "Translate the selected text (or the page) in place",
    args: "German",
    action: "translate",
  },
  {
    id: "resize",
    label: "Magic resize",
    description: "Copy this design to other sizes with smart reflow",
    args: "instagram-story",
    action: "workflow.resize",
    dialog: true,
  },
  {
    id: "variants",
    label: "Variants",
    description: "A/B alternatives along one axis",
    args: "3 color",
    action: "workflow.variants",
    dialog: true,
  },
  {
    id: "campaign",
    label: "Campaign",
    description: "One brief, a coherent set of designs",
    args: "spring launch for a coffee roaster",
    action: "workflow.campaign",
    dialog: true,
  },
  {
    id: "brand",
    label: "Match brand",
    description: "Restyle with your brand kit's colors, fonts and logo",
    args: "",
    action: "brand",
  },
];

export function slashCommand(id: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.id === id);
}

/** The command a prompt starts with (`/expand 16:9 left`), or null for a plain prompt. */
export function parseSlash(text: string): { command: SlashCommand; args: string } | null {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = slashCommand((m[1] as string).toLowerCase());
  return command ? { command, args: (m[2] ?? "").trim() } : null;
}

/**
 * Suggestions while the user types a command name (`/re` -> remove-bg, resize). Null when the text is not a
 * command being typed (a space ends the name).
 */
export function slashSuggestions(text: string): SlashCommand[] | null {
  const m = /^\/([a-z-]*)$/i.exec(text);
  if (!m) return null;
  const q = (m[1] as string).toLowerCase();
  const starts = SLASH_COMMANDS.filter((c) => c.id.startsWith(q));
  const contains = SLASH_COMMANDS.filter(
    (c) =>
      !starts.includes(c) &&
      (c.id.includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)),
  );
  return [...starts, ...contains];
}

// ---------------------------------------------------------------------------------------------------------
// Command arguments

export const ASPECTS: readonly { id: string; label: string; ratio: number }[] = [
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "4:5", label: "Portrait 4:5", ratio: 4 / 5 },
  { id: "3:4", label: "Portrait 3:4", ratio: 3 / 4 },
  { id: "9:16", label: "Story 9:16", ratio: 9 / 16 },
  { id: "3:2", label: "Landscape 3:2", ratio: 3 / 2 },
  { id: "16:9", label: "Wide 16:9", ratio: 16 / 9 },
  { id: "21:9", label: "Cinema 21:9", ratio: 21 / 9 },
];

const ASPECT_WORDS: Record<string, string> = {
  square: "1:1",
  portrait: "4:5",
  story: "9:16",
  vertical: "9:16",
  landscape: "3:2",
  wide: "16:9",
  widescreen: "16:9",
  cinema: "21:9",
  panorama: "21:9",
};

const DIRECTIONS: readonly OutpaintDirection[] = [
  "all",
  "left",
  "right",
  "up",
  "down",
  "horizontal",
  "vertical",
];

export interface ExpandArgs {
  aspect: string | null;
  ratio: number | null;
  direction: OutpaintDirection;
  prompt: string;
}

/** `/expand 16:9 left beach at dusk` -> aspect 16:9, direction left, prompt "beach at dusk". */
export function parseExpandArgs(args: string): ExpandArgs {
  let aspect: string | null = null;
  let ratio: number | null = null;
  let direction: OutpaintDirection = "all";
  const rest: string[] = [];
  for (const word of args.split(/\s+/).filter(Boolean)) {
    const w = word.toLowerCase();
    const r = /^(\d+(?:\.\d+)?)[:x/](\d+(?:\.\d+)?)$/.exec(w);
    if (!aspect && r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      if (a > 0 && b > 0) {
        aspect = `${r[1]}:${r[2]}`;
        ratio = a / b;
        continue;
      }
    }
    if (!aspect && ASPECT_WORDS[w]) {
      aspect = ASPECT_WORDS[w] as string;
      ratio = ASPECTS.find((x) => x.id === aspect)?.ratio ?? null;
      continue;
    }
    const dir = w === "top" ? "up" : w === "bottom" ? "down" : w;
    if ((DIRECTIONS as readonly string[]).includes(dir) && direction === "all") {
      direction = dir as OutpaintDirection;
      continue;
    }
    rest.push(word);
  }
  return { aspect, ratio, direction, prompt: rest.join(" ") };
}

/**
 * Target size for expanding a `w`×`h` image to `ratio`, growing only along `direction` (the source is never
 * cropped: the other axis keeps its size). Mirrors @desyn/ai `outpaintExpansion` for the preview.
 */
export function expandTarget(
  w: number,
  h: number,
  ratio: number,
  direction: OutpaintDirection,
): {
  width: number;
  height: number;
  grow: { left: number; right: number; top: number; bottom: number };
} {
  const current = w / h;
  let width = w;
  let height = h;
  const horizontalOnly =
    direction === "left" || direction === "right" || direction === "horizontal";
  const verticalOnly = direction === "up" || direction === "down" || direction === "vertical";
  if (horizontalOnly) width = Math.max(w, h * ratio);
  else if (verticalOnly) height = Math.max(h, w / ratio);
  else if (ratio > current) width = h * ratio;
  else height = w / ratio;
  width = Math.round(width);
  height = Math.round(height);
  const extraX = width - w;
  const extraY = height - h;
  const half = (n: number): [number, number] => [Math.floor(n / 2), Math.ceil(n / 2)];
  const [hx0, hx1] = half(extraX);
  const [vy0, vy1] = half(extraY);
  const grow = { left: hx0, right: hx1, top: vy0, bottom: vy1 };
  if (direction === "left") Object.assign(grow, { left: extraX, right: 0 });
  if (direction === "right") Object.assign(grow, { left: 0, right: extraX });
  if (direction === "up") Object.assign(grow, { top: extraY, bottom: 0 });
  if (direction === "down") Object.assign(grow, { top: 0, bottom: extraY });
  return { width, height, grow };
}

/** `/upscale 4x` -> 4 (2 by default; only 2 and 4 are offered). */
export function parseUpscaleFactor(args: string): 2 | 4 {
  return /\b4\s*x?\b|×\s*4|4×/i.test(args) ? 4 : 2;
}

export const VARIANT_AXES = ["copy", "color", "layout", "image"] as const;
export type VariantAxis = (typeof VARIANT_AXES)[number];

/** `/variants 3 color` -> { count: 3, axis: "color" }. */
export function parseVariantArgs(args: string): { count: number; axis: VariantAxis | null } {
  const n = /\b([1-8])\b/.exec(args);
  const axis = VARIANT_AXES.find((a) => new RegExp(`\\b${a}s?\\b`, "i").test(args)) ?? null;
  return { count: n ? Number(n[1]) : 3, axis };
}

// ---------------------------------------------------------------------------------------------------------
// Goals

export interface GoalContext {
  mode: DockMode;
  prompt: string;
  /** Brand toggle: null when the design has no brand kit (nothing to say about it). */
  brand: boolean | null;
  /** Names of attached images and snapshots, mentioned so the agent knows they exist. */
  attachments: string[];
}

const BRAND_ON =
  "Follow the brand kit for this request: use its colors, fonts, logos and voice where they fit.";
const BRAND_OFF =
  "Do not apply the brand kit for this request; choose colors and fonts freely for the brief.";

/** The agent goal for a dock prompt (the user's words first, then mode and context notes). */
export function buildGoal(ctx: GoalContext): string {
  const parts = [ctx.prompt.trim()];
  if (ctx.mode === "edit-selection") {
    parts.push("Change only the selected elements unless the request clearly needs more.");
  }
  if (ctx.mode === "critique") {
    parts.push("Review only: point out the most important issues and how to fix them.");
  }
  if (ctx.attachments.length > 0) {
    parts.push(`Attached for reference: ${ctx.attachments.join(", ")}.`);
  }
  if (ctx.brand !== null && ctx.mode !== "critique") parts.push(ctx.brand ? BRAND_ON : BRAND_OFF);
  return parts.filter(Boolean).join("\n\n");
}

export type TextAction =
  | { kind: "rewrite" }
  | { kind: "shorten" }
  | { kind: "lengthen" }
  | { kind: "tone"; tone: string }
  | { kind: "translate"; language: string }
  | { kind: "fix" };

export const TONES = [
  "Confident",
  "Friendly",
  "Playful",
  "Elegant",
  "Bold",
  "Calm",
  "Professional",
  "Urgent",
] as const;

export const LANGUAGES: readonly { code: string; label: string; rtl?: boolean }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "nb", label: "Norwegian" },
  { code: "fi", label: "Finnish" },
  { code: "pl", label: "Polish" },
  { code: "cs", label: "Czech" },
  { code: "ro", label: "Romanian" },
  { code: "hu", label: "Hungarian" },
  { code: "el", label: "Greek" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic", rtl: true },
  { code: "he", label: "Hebrew", rtl: true },
  { code: "fa", label: "Persian", rtl: true },
  { code: "ur", label: "Urdu", rtl: true },
  { code: "hi", label: "Hindi" },
  { code: "bn", label: "Bengali" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
  { code: "sw", label: "Swahili" },
];

/** Resolves "German", "de" or "deutsch"-like input to a language entry (exact label / code, then prefix). */
export function findLanguage(input: string): { code: string; label: string } | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  return (
    LANGUAGES.find((l) => l.code.toLowerCase() === q || l.label.toLowerCase() === q) ??
    LANGUAGES.find((l) => l.label.toLowerCase().startsWith(q)) ??
    null
  );
}

/** Goal for a text action on the selected text layers. */
export function textActionGoal(action: TextAction): { goal: string; label: string } {
  const keep =
    "Keep each text layer's role, and adjust the font size only if the text no longer fits its box.";
  switch (action.kind) {
    case "rewrite":
      return {
        label: "Rewrite",
        goal: `Rewrite the selected text so it reads better. Keep its meaning, rough length and tone. ${keep}`,
      };
    case "shorten":
      return {
        label: "Shorten",
        goal: `Shorten the selected text to about half its length while keeping the key message. ${keep}`,
      };
    case "lengthen":
      return {
        label: "Expand copy",
        goal: `Expand the selected text with one more concrete detail, at most about 50% longer. ${keep}`,
      };
    case "tone":
      return {
        label: `${action.tone} tone`,
        goal: `Rewrite the selected text in a ${action.tone.toLowerCase()} tone without changing what it says. ${keep}`,
      };
    case "translate":
      return {
        label: `Translate to ${action.language}`,
        goal: `Translate the selected text into ${action.language}. ${keep}`,
      };
    case "fix":
      return {
        label: "Fix spelling",
        goal: `Fix spelling, grammar and punctuation in the selected text. Change nothing else. ${keep}`,
      };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Credits

/** Credits one use of `action` costs on platform billing (BYOK and local runs cost nothing). */
export function creditsFor(action: CreditAction, count = 1): number {
  return creditCost(action) * Math.max(0, count);
}

/** "1 credit", "12 credits", "free". */
export function formatCredits(n: number): string {
  if (n <= 0) return "free";
  return `${n} credit${n === 1 ? "" : "s"}`;
}
