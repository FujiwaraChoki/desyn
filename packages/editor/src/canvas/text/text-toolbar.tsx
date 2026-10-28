"use client";

import { getNode } from "@desyn/doc-ops";
import type { TextNode, TextStyle } from "@desyn/schema";
import { cn, Toolbar, ToolbarButton, ToolbarSeparator } from "@desyn/ui";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  Strikethrough,
  Underline,
} from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { useEditorStore } from "../../context.tsx";
import type { CanvasController } from "../controller.ts";
import { nodeObb } from "../geometry.ts";
import { obbCorners } from "../math.ts";
import { fmtNum } from "../overlay/paint.ts";
import { TextMode } from "./text-mode.ts";

/**
 * Floating text toolbar while editing text on the canvas: emphasis and size for the selected range, alignment
 * and lists for the layer. Buttons never take focus, so the caret and IME stay in the text.
 */

const keep = (e: { preventDefault(): void }) => e.preventDefault();

function Btn({
  label,
  shortcut,
  active,
  onPress,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <ToolbarButton
      label={label}
      {...(shortcut ? { shortcut } : {})}
      {...(active === undefined ? {} : { active })}
      size="sm"
      tabIndex={-1}
      onMouseDown={keep}
      onPointerDown={keep}
      onClick={onPress}
      className={cn(active && "bg-accent-tint text-accent")}
    >
      {children}
    </ToolbarButton>
  );
}

export function TextToolbar({ controller }: { controller: CanvasController }) {
  const ui = useSyncExternalStore(controller.subscribeUi, controller.getUi, controller.getUi);
  // Re-position with the view and the document.
  useEditorStore((s) => s.viewport);
  const design = useEditorStore((s) => s.doc.design);
  const text = ui.text;
  const mode = controller.mode;
  if (!text || !(mode instanceof TextMode) || !design) return null;
  const node = getNode(design, text.nodeId) as TextNode | undefined;
  const box = node ? nodeObb(design, node.id) : null;
  if (!node || !box) return null;
  const style: TextStyle | null = mode.styleAt();
  const corners = obbCorners(box).map((p) => controller.toScreen(p));
  const top = Math.min(...corners.map((p) => p.y));
  const bottom = Math.max(...corners.map((p) => p.y));
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const above = top - 52 > 8;
  const y = above ? top - 52 : bottom + 12;
  const bold = (style?.fontWeight ?? 400) >= 600;
  const align = node.paragraph.align;
  const list = node.paragraph.list;
  return (
    <div
      data-canvas-chrome=""
      className="pointer-events-auto absolute z-[4] -translate-x-1/2 animate-fade-up"
      style={{ left: Math.round(cx), top: Math.round(y) }}
    >
      <Toolbar aria-label="Text formatting" className="shadow-dialog">
        <Btn label="Bold" shortcut={"mod+b"} active={bold} onPress={() => mode.toggleBold()}>
          <Bold />
        </Btn>
        <Btn
          label="Italic"
          shortcut={"mod+i"}
          active={style?.fontStyle === "italic"}
          onPress={() => mode.toggle("fontStyle", "italic")}
        >
          <Italic />
        </Btn>
        <Btn
          label="Underline"
          shortcut={"mod+u"}
          active={style?.decoration === "underline"}
          onPress={() => mode.toggle("decoration", "underline")}
        >
          <Underline />
        </Btn>
        <Btn
          label="Strikethrough"
          shortcut={"mod+shift+x"}
          active={style?.decoration === "strikethrough"}
          onPress={() => mode.toggle("decoration", "strikethrough")}
        >
          <Strikethrough />
        </Btn>
        <ToolbarSeparator />
        <Btn label="Smaller" shortcut={"mod+shift+,"} onPress={() => mode.stepSize(-1)}>
          <Minus />
        </Btn>
        <span
          className="min-w-9 select-none text-center font-mono text-xs text-fg-secondary tabular-nums"
          title="Font size"
        >
          {fmtNum(style?.fontSize ?? node.style.fontSize)}
        </span>
        <Btn label="Larger" shortcut={"mod+shift+."} onPress={() => mode.stepSize(1)}>
          <Plus />
        </Btn>
        <ToolbarSeparator />
        {(
          [
            ["left", "Align left", AlignLeft, "l"],
            ["center", "Align center", AlignCenter, "t"],
            ["right", "Align right", AlignRight, "r"],
            ["justify", "Justify", AlignJustify, "j"],
          ] as const
        ).map(([value, label, Icon, key]) => (
          <Btn
            key={value}
            label={label}
            shortcut={`mod+alt+${key}`}
            active={align === value}
            onPress={() => void mode.setParagraph({ align: value })}
          >
            <Icon />
          </Btn>
        ))}
        <ToolbarSeparator />
        <Btn
          label="Bulleted list"
          shortcut={"mod+shift+8"}
          active={list === "bullet"}
          onPress={() => void mode.setParagraph({ list: list === "bullet" ? "none" : "bullet" })}
        >
          <List />
        </Btn>
        <Btn
          label="Numbered list"
          shortcut={"mod+shift+7"}
          active={list === "number"}
          onPress={() => void mode.setParagraph({ list: list === "number" ? "none" : "number" })}
        >
          <ListOrdered />
        </Btn>
      </Toolbar>
    </div>
  );
}
