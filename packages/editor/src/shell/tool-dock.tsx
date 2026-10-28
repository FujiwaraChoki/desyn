"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Toolbar,
  ToolbarSeparator,
  ToolbarToggleGroup,
  ToolbarToggleItem,
} from "@desyn/ui";
import { ChevronUp } from "lucide-react";
import { useRef } from "react";
import { useCommand, useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { activeTool, type ToolId } from "../store/editor-store.ts";
import { CommandButton } from "./command-items.tsx";
import { availableIn, type ToolDef } from "./extensions.ts";

function ToolItem({ tool }: { tool: ToolDef }) {
  const { shortcut } = useCommand(tool.command);
  const Icon = tool.icon;
  return (
    <ToolbarToggleItem value={tool.id} label={tool.label} {...(shortcut ? { shortcut } : {})}>
      <Icon />
    </ToolbarToggleItem>
  );
}

/** Tools of one group share a slot; the chevron picks another (the last used one stays shown). */
function GroupMenu({ tools, onPick }: { tools: ToolDef[]; onPick: (id: ToolId) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More ${tools[0]?.group ?? ""} tools`}
          className="-ml-1 grid h-8 w-3.5 place-items-center rounded-[6px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:text-fg [&_svg]:size-3"
        >
          <ChevronUp />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-48">
        {tools.map((t) => (
          <ToolMenuItem key={t.id} tool={t} onPick={onPick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolMenuItem({ tool, onPick }: { tool: ToolDef; onPick: (id: ToolId) => void }) {
  const { shortcut } = useCommand(tool.command, "menu");
  const Icon = tool.icon;
  return (
    <DropdownMenuItem
      icon={<Icon />}
      {...(shortcut ? { shortcut } : {})}
      onSelect={() => onPick(tool.id)}
    >
      {tool.label}
    </DropdownMenuItem>
  );
}

/** Bottom-center floating tool dock (select, frame, shapes, pen, text, image, hand, comment). */
export function ToolDock() {
  const editor = useEditor();
  useRegistryVersion();
  const mode = useEditorStore((s) => s.mode);
  const tool = useEditorStore(activeTool);
  const lastInGroup = useRef(new Map<string, ToolId>());
  const tools = editor.extensions.tools.filter((t) => availableIn(t, mode));
  if (tools.length === 0) return null;

  const groups: { group: string; tools: ToolDef[] }[] = [];
  for (const t of tools) {
    const g = groups.find((x) => x.group === t.group);
    if (g) g.tools.push(t);
    else groups.push({ group: t.group, tools: [t] });
  }
  // Remember the last tool used in each group so the dock shows it.
  const activeDef = tools.find((t) => t.id === tool);
  if (activeDef) lastInGroup.current.set(activeDef.group, activeDef.id);
  const pick = (id: ToolId) => editor.setTool(id);

  return (
    <Toolbar
      aria-label="Tools"
      className="pointer-events-auto flex items-center gap-0.5 shadow-dialog"
    >
      <ToolbarToggleGroup
        type="single"
        value={tool}
        onValueChange={(v) => {
          if (v) pick(v);
        }}
        aria-label="Tool"
      >
        {groups.map(({ group, tools: list }) => {
          // The select group shows both select and hand side by side; other groups collapse to one slot.
          if (group === "select" || list.length === 1) {
            return list.map((t) => <ToolItem key={t.id} tool={t} />);
          }
          const shownId = list.some((t) => t.id === tool)
            ? tool
            : (lastInGroup.current.get(group) ?? list[0]?.id);
          const shown = list.find((t) => t.id === shownId) ?? (list[0] as ToolDef);
          return (
            <span key={group} className="flex items-center">
              <ToolItem tool={shown} />
              <GroupMenu tools={list} onPick={pick} />
            </span>
          );
        })}
      </ToolbarToggleGroup>
      {mode === "edit" ? (
        <>
          <ToolbarSeparator />
          <CommandButton id="tool.image" variant="ghost" size="md" />
        </>
      ) : null}
    </Toolbar>
  );
}
