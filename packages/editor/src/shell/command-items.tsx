"use client";

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  IconButton,
  type IconButtonProps,
} from "@desyn/ui";
import type { ReactNode } from "react";
import { useCommand, useEditor } from "../context.tsx";

/**
 * Menu rows and buttons bound to commands: label, icon, shortcut, enablement and check state all come from
 * the command registry, so every surface shows the same thing. Missing commands render nothing.
 */

const DESTRUCTIVE: ReadonlySet<string> = new Set(["edit.delete", "page.delete"]);

export function CommandMenuItem({
  id,
  args,
  label,
}: {
  id: string;
  args?: unknown;
  label?: string;
}) {
  const editor = useEditor();
  const c = useCommand(id, "menu");
  if (!c.exists) return null;
  const Icon = editor.commands.get(id)?.icon;
  if (c.checked !== undefined) {
    return (
      <DropdownMenuCheckboxItem
        checked={c.checked}
        disabled={!c.enabled}
        {...(c.shortcut ? { shortcut: c.shortcut } : {})}
        onSelect={() => void c.run(args)}
      >
        {label ?? c.label}
      </DropdownMenuCheckboxItem>
    );
  }
  return (
    <DropdownMenuItem
      icon={Icon ? <Icon /> : undefined}
      disabled={!c.enabled}
      destructive={DESTRUCTIVE.has(id)}
      {...(c.shortcut ? { shortcut: c.shortcut } : {})}
      onSelect={() => void c.run(args)}
    >
      {label ?? c.label}
    </DropdownMenuItem>
  );
}

export function CommandContextItem({ id, args }: { id: string; args?: unknown }) {
  const editor = useEditor();
  const c = useCommand(id, "menu");
  if (!c.exists || !c.enabled) return null;
  const Icon = editor.commands.get(id)?.icon;
  if (c.checked !== undefined) {
    return (
      <ContextMenuCheckboxItem checked={c.checked} onSelect={() => void c.run(args)}>
        {c.label}
      </ContextMenuCheckboxItem>
    );
  }
  return (
    <ContextMenuItem
      icon={Icon ? <Icon /> : undefined}
      destructive={DESTRUCTIVE.has(id)}
      {...(c.shortcut ? { shortcut: c.shortcut } : {})}
      onSelect={() => void c.run(args)}
    >
      {c.label}
    </ContextMenuItem>
  );
}

/** Icon button running a command (tooltip shows its label and shortcut). */
export function CommandButton({
  id,
  args,
  children,
  label,
  ...props
}: { id: string; args?: unknown; children?: ReactNode; label?: string } & Omit<
  IconButtonProps,
  "label" | "onClick" | "children"
>) {
  const editor = useEditor();
  const c = useCommand(id);
  if (!c.exists) return null;
  const Icon = editor.commands.get(id)?.icon;
  return (
    <IconButton
      label={label ?? c.label}
      disabled={!c.enabled}
      {...(c.shortcut ? { shortcut: c.shortcut } : {})}
      {...(c.checked !== undefined ? { active: c.checked } : {})}
      onClick={() => void c.run(args)}
      {...props}
    >
      {children ?? (Icon ? <Icon /> : null)}
    </IconButton>
  );
}
