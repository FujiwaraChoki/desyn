import {
  Circle,
  Frame,
  Hand,
  ImagePlus,
  MessageCircle,
  MousePointer2,
  MoveUpRight,
  PenTool,
  Slash,
  Square,
  Star,
  Triangle,
  Type,
} from "lucide-react";
import type { ToolDef } from "../shell/extensions.ts";
import type { ToolId } from "../store/editor-store.ts";
import type { AnyCommand, CommandIcon } from "./registry.ts";

/**
 * Built-in tools. The store holds the active tool; the canvas interaction layer (an extension) implements what
 * each tool does on the canvas. "Place image" is an action, not a mode: it opens the file picker.
 */
interface ToolSpec {
  id: ToolId;
  label: string;
  icon: CommandIcon;
  group: string;
  /** Available in comment / view modes. */
  readOnly?: boolean;
  commentOnly?: boolean;
}

export const BUILTIN_TOOLS: ToolSpec[] = [
  { id: "select", label: "Select", icon: MousePointer2, group: "select", readOnly: true },
  { id: "hand", label: "Hand", icon: Hand, group: "select", readOnly: true },
  { id: "frame", label: "Frame", icon: Frame, group: "frame" },
  { id: "rect", label: "Rectangle", icon: Square, group: "shapes" },
  { id: "ellipse", label: "Ellipse", icon: Circle, group: "shapes" },
  { id: "polygon", label: "Polygon", icon: Triangle, group: "shapes" },
  { id: "star", label: "Star", icon: Star, group: "shapes" },
  { id: "line", label: "Line", icon: Slash, group: "shapes" },
  { id: "arrow", label: "Arrow", icon: MoveUpRight, group: "shapes" },
  { id: "pen", label: "Pen", icon: PenTool, group: "pen" },
  { id: "text", label: "Text", icon: Type, group: "text" },
  { id: "comment", label: "Comment", icon: MessageCircle, group: "comment", commentOnly: true },
];

export function toolCommandId(tool: ToolId): string {
  return `tool.${tool}`;
}

export function builtinToolDefs(): ToolDef[] {
  return BUILTIN_TOOLS.map((t, i) => ({
    id: t.id,
    label: t.label,
    icon: t.icon,
    group: t.group,
    order: (i + 1) * 10,
    command: toolCommandId(t.id),
    ...(t.readOnly ? {} : t.commentOnly ? { modes: ["edit", "comment"] } : { modes: ["edit"] }),
  }));
}

export function toolCommands(): AnyCommand[] {
  const tools: AnyCommand[] = BUILTIN_TOOLS.map((t) => ({
    id: toolCommandId(t.id),
    label: `${t.label} tool`,
    category: "tool",
    icon: t.icon,
    when: t.readOnly
      ? "loaded && !textEditing"
      : t.commentOnly
        ? "canComment && !textEditing"
        : "canEdit && !textEditing",
    checked: (ctx) => ctx.tool === t.id,
    run: (_a, { editor }) => editor.setTool(t.id),
  }));
  return [
    ...tools,
    {
      id: "tool.image",
      label: "Place image…",
      category: "tool",
      icon: ImagePlus,
      keywords: ["upload", "photo", "picture"],
      when: "canEdit && !textEditing",
      run: (_a, { editor }) => editor.clipboard.pickAndPlaceImages(),
    },
  ];
}
