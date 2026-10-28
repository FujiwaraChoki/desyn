"use client";

import { pages } from "@desyn/doc-ops";
import type { Node } from "@desyn/schema";
import { CommandGroup, CommandItem, CommandPalette } from "@desyn/ui";
import { FileText, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { CATEGORY_LABELS, type CommandCategory } from "../commands/registry.ts";
import { useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { keysFor } from "../shortcuts/keymap.ts";

const ORDER: CommandCategory[] = [
  "ai",
  "edit",
  "clipboard",
  "arrange",
  "selection",
  "tool",
  "view",
  "page",
  "panel",
  "file",
  "collab",
  "text",
  "history",
  "help",
];

const MAX_LAYERS = 40;

/** ⌘K: every enabled command, pages, and layers of the current page by name. */
export function EditorCommandPalette() {
  const editor = useEditor();
  useRegistryVersion();
  const open = useEditorStore((s) => s.paletteOpen);
  const keymap = useEditorStore((s) => s.keymap);
  const design = useEditorStore((s) => s.doc.design);
  const pageId = useEditorStore((s) => s.pageId);
  const [search, setSearch] = useState("");
  const close = () => {
    editor.store.setState({ paletteOpen: false });
    setSearch("");
  };

  const groups = useMemo(() => {
    if (!open) return [];
    const ctx = editor.context();
    const byCat = new Map<CommandCategory, { id: string; label: string; keywords: string[] }[]>();
    for (const c of editor.commands.all()) {
      if (c.hidden || !editor.commands.isEnabled(c.id, ctx)) continue;
      const list = byCat.get(c.category) ?? [];
      list.push({ id: c.id, label: editor.commands.label(c.id, ctx), keywords: c.keywords ?? [] });
      byCat.set(c.category, list);
    }
    return ORDER.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      items: byCat.get(c) ?? [],
    }));
  }, [open, editor]);

  const pageList = design ? pages(design) : [];
  const layers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!open || !design || !pageId || q.length < 2) return [];
    const out: Node[] = [];
    const walk = (id: string) => {
      const n = design.nodes[id];
      if (!n || out.length >= MAX_LAYERS) return;
      if (n.type !== "page" && n.name.toLowerCase().includes(q)) out.push(n);
      if ("children" in n) for (const c of n.children) walk(c);
    };
    walk(pageId);
    return out;
  }, [open, design, pageId, search]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={(o) => (o ? editor.store.setState({ paletteOpen: true }) : close())}
      shortcut={null}
      search={search}
      onSearchChange={setSearch}
      placeholder="Search commands, pages and layers…"
      title="Editor commands"
    >
      {layers.length > 0 ? (
        <CommandGroup heading="Layers on this page">
          {layers.map((n) => (
            <CommandItem
              key={n.id}
              value={`layer ${n.name} ${n.id}`}
              icon={<Square />}
              hint={n.type}
              onSelect={() => {
                close();
                editor.select([n.id]);
                void editor.commands.run("view.zoomSelection", undefined, "palette");
              }}
            >
              {n.name}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {groups.map(({ category, items }) => (
        <CommandGroup key={category} heading={CATEGORY_LABELS[category]}>
          {items.map((item) => {
            const Icon = editor.commands.get(item.id)?.icon;
            const shortcut = keysFor(item.id, keymap, editor.commands.get(item.id)?.keys)[0];
            return (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.id}`}
                keywords={item.keywords}
                icon={Icon ? <Icon /> : undefined}
                {...(shortcut ? { shortcut } : {})}
                onSelect={() => {
                  close();
                  void editor.commands.run(item.id, undefined, "palette");
                }}
              >
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      ))}
      {pageList.length > 1 ? (
        <CommandGroup heading="Go to page">
          {pageList.map((p, i) => (
            <CommandItem
              key={p.id}
              value={`page ${i + 1} ${p.name}`}
              icon={<FileText />}
              hint={`Page ${i + 1}`}
              onSelect={() => {
                close();
                editor.setPage(p.id);
              }}
            >
              {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </CommandPalette>
  );
}
